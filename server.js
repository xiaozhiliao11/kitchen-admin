/**
 * kitchen-admin 主服务
 * Node.js + Express + MQTT + WebSocket
 *
 * 职责：
 *  1. 订阅 MQTT，接收所有主机的 status / event / diag 上报
 *  2. 维护设备状态库（JSON 文件持久化），心跳超时判离线
 *  3. 开发者模式：下发开关指令，TTL 超时自动关闭
 *  4. REST API + WebSocket 实时推送（后台网页）
 *
 * 运行：npm install && npm start
 */
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const mqtt = require('mqtt');
const { WebSocketServer } = require('ws');

const config = require('./config');
const store = require('./store');
const insights = require('./insights');
const { analyzeDiag, normalizeDiagItems: insightsDiagItems } = require('./diag');
const { DEFAULT_WORKFLOW, DEFAULT_AI, sanitizeWorkflow, sanitizeAI, runWorkflow } = require('./workflow');

const app = express();
// 云端部署在反向代理之后：不信任代理头会拿到 http:// 与内部主机名，
// 而入 OTA 下载地址要发给设备直接抓取，协议/域名错一个设备就下不动。
app.set('trust proxy', 1);
app.disable('x-powered-by');
// 统一安全响应头：防点击劫持（ifram 嵌入后台骗管理员点删除）、防 MIME 嗅探、防 Referer 带出地址
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
  next();
});
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    // 安装包必须带 attachment：否则浏览器/壳会按网页处理，用户拿不到能直接双击的 .exe
    const base = path.basename(filePath).toLowerCase();
    if (base.endsWith('.exe') || base.endsWith('.apk')) {
      const label = base.endsWith('.exe') ? '电脑版.exe' : '安卓版.apk';
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition',
        'attachment; filename="xzl-kitchen-' + APP_VERSION + (base.endsWith('.exe') ? '-setup.exe' : '.apk') + '"; ' +
        "filename*=UTF-8''" + encodeURIComponent('小知了厨房卫士-' + APP_VERSION + '-' + label));
    }
  },
}));
// 前端烧录依赖：esptool-js 浏览器库（WebSerial 真烧录）+ 固件库静态目录
app.use('/vendor/esptool-js', express.static(path.join(__dirname, 'node_modules', 'esptool-js')));
// 不再匿名暴露固件目录：固件只能通过 /api/firmwares/:id/download 取（该接口会校验登录或签名链接）

/* ---------------- 账号登录体系（管理员 + 团队子账号） ---------------- */
// 会话签名密钥：优先环境变量；否则首启生成随机密钥并落盘（data/session-secret），
// 保证重启不掉登录、且不依赖写死的默认值（默认值公开可伪造令牌）
function loadSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (process.env.ADMIN_TOKEN) return process.env.ADMIN_TOKEN;
  const f = path.join(config.dataDir, 'session-secret');
  try {
    const s = fs.readFileSync(f, 'utf8').trim();
    if (s.length >= 32) return s;
  } catch {}
  const s = crypto.randomBytes(24).toString('hex');
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(f, s);
  } catch (e) { console.error('[认证] 会话密钥落盘失败：' + e.message); }
  return s;
}
const SESSION_SECRET = loadSessionSecret();
const TOKEN_TTL_MS = 7 * 24 * 3600 * 1000;          // 登录状态保持 7 天（免重复登录）
const ACCOUNT_RE = /^[A-Za-z0-9_-]{3,32}$/;
const PWD_MIN = 6, PWD_MAX = 64;
const ROOT_ADMIN = '17067459876';

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 32).toString('hex');
  return { salt, hash };
}
function verifyPassword(pw, salt, hash) {
  try {
    const h = crypto.scryptSync(pw, salt, 32);
    const expect = Buffer.from(hash, 'hex');
    return h.length === expect.length && crypto.timingSafeEqual(h, expect);
  } catch { return false; }
}
function signToken(account, role) {
  const exp = Date.now() + TOKEN_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ a: account, r: role, e: exp })).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return payload + '.' + sig;
}
/* 固件下载链接签名：让「知道 id」不再等于「能拿到文件」。
 * 设备 OTA 无法携带登录令牌，所以用带过期时间的签名链接代替匿名开放。 */
const FW_URL_SECRET = process.env.FW_URL_SECRET || SESSION_SECRET;   // 复用已加载的会话密钥（它有落盘持久化保障）
function fwUrlSig(id, exp) {
  if (!FW_URL_SECRET) return '';
  return crypto.createHmac('sha256', FW_URL_SECRET).update(id + '|' + exp).digest('hex').slice(0, 32);
}
function fwUrlOk(id, q) {
  if (!FW_URL_SECRET) return false;
  const exp = Number(q && q.e), k = String((q && q.k) || '');
  if (!Number.isFinite(exp) || exp < Date.now() || !k) return false;
  const expect = fwUrlSig(id, exp);
  const a = Buffer.from(k), b = Buffer.from(expect);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
/* 生成可直接交给设备/浏览器的签名下载地址（默认 30 分钟有效） */
function signedFwUrl(id, baseUrl, minutes) {
  const exp = Date.now() + (minutes || 30) * 60 * 1000;
  const k = fwUrlSig(id, exp);
  return (baseUrl || '') + '/api/firmwares/' + encodeURIComponent(id) + '/download?e=' + exp + (k ? '&k=' + k : '');
}

function verifyToken(token) {
  try {
    const [p, s] = String(token || '').split('.');
    if (!p || !s) return null;
    const sig = crypto.createHmac('sha256', SESSION_SECRET).update(p).digest('base64url');
    if (sig.length !== s.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(s))) return null;
    const j = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    if (!j || !j.a || (j.e || 0) < Date.now()) return null;
    const u = store.getUser(j.a);
    if (!u || (u.status || 'active') === 'paused') return null;   // 暂停/删除后会话立即失效
    return { account: u.account, role: u.role, name: u.name || '' };
  } catch { return null; }
}
// 登录失败限速（内存）：同账号连续 5 次失败锁 60 秒
const loginFails = new Map();
function loginLocked(account) { const f = loginFails.get(account); return !!(f && f.until > Date.now()); }
function loginFail(account) {
  const f = loginFails.get(account) || { count: 0, until: 0 };
  f.count += 1;
  if (f.count >= 5) { f.until = Date.now() + 60000; f.count = 0; }
  loginFails.set(account, f);
}
// 首次部署开箱即用：无任何用户时创建管理员账号
(function initAdmin() {
  if (Object.keys(store.getUsers()).length > 0) return;
  const { salt, hash } = hashPassword('123456');
  store.upsertUser({ account: ROOT_ADMIN, name: '管理员', role: 'admin', status: 'active', salt, hash, createdAt: Date.now(), lastLoginAt: 0 });
  console.log('[认证] 已初始化管理员账号 ' + ROOT_ADMIN);
})();

// 固件库自愈：部署可能重置容器，firmwareDir 里的 .bin 与 meta.json 需对齐。
// 按文件名规则 {id}_{name}_v{version}.bin 重建缺失索引，剔除已不存在的文件记录。
(function rebuildFirmwareIndex() {
  try {
    if (!fs.existsSync(config.firmwareDir)) fs.mkdirSync(config.firmwareDir, { recursive: true });
    const disks = fs.readdirSync(config.firmwareDir).filter((f) => f.endsWith('.bin'));
    const old = store.getFirmwares();
    const meta = old.filter((fw) => fw.fileName && fs.existsSync(path.join(config.firmwareDir, fw.fileName)));
    const known = new Set(meta.map((fw) => fw.fileName));
    let added = 0;
    for (const f of disks) {
      if (known.has(f)) continue;
      const m = f.match(/^([0-9a-f]{8})_(.+)_v([\w.\-]+)\.bin$/);
      if (!m) continue;
      const p = path.join(config.firmwareDir, f);
      const st = fs.statSync(p);
      meta.push({
        id: m[1],
        name: m[2],
        version: m[3],
        note: '启动时自动重建索引',
        size: st.size,
        sha256: crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'),
        fileName: f,
        uploadedAt: Math.round(st.mtimeMs)
      });
      added++;
    }
    if (added > 0 || meta.length !== old.length) {
      store.saveFirmwares(meta);
      console.log('[固件库] 索引已同步：' + meta.length + ' 个固件（新增 ' + added + '）');
    }
  } catch (e) { console.error('[固件库] 自愈失败：' + e.message); }
})();

// 鉴权中间件：豁免 健康检查 / 登录 / OTA 固件下载（设备 HTTP 下载不带令牌）
// 注意：挂在 '/api' 上时 req.path 是去前缀后的路径（'/health'），必须用 originalUrl 判断
// 后台版本号：与电脑端 / 安卓端保持同一版本，改版时同步递增
const APP_VERSION = '1.1.2';

// 上行数据签名密钥：与固件 dev_secret 同值。未设置时进入兼容模式（只记录不拦截），
// 设置 DEV_SECRET_STRICT=1 后才强制丢弃未签名/签名错误的上报。
const DEV_SECRET = process.env.DEV_SECRET || '';
const DEV_SECRET_STRICT = process.env.DEV_SECRET_STRICT === '1';
const lastReportTs = new Map();   // device|kind -> 最近一次已接受的时间戳（防重放）

function verifyDeviceSig(device, kind, msg) {
  if (!DEV_SECRET) return { ok: true, relaxed: true };
  const sig = msg && msg.sig;
  const ts = Number(msg && msg.ts);
  if (!sig || !Number.isFinite(ts) || ts <= 0) {
    return { ok: false, why: '上报未带签名', strict: DEV_SECRET_STRICT };
  }
  const data = device + '|' + String(ts) + '|' + kind;
  const expect = crypto.createHmac('sha256', DEV_SECRET).update(data).digest('hex');
  // 恒定时间比较：长度不等直接判失败，长度相等用 timingSafeEqual，避免逐字节提前返回泄露时序
  const a = Buffer.from(String(sig), 'utf8'), b = Buffer.from(expect, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, why: '上报签名不匹配', strict: DEV_SECRET_STRICT };
  }
  const key = device + '|' + kind;
  const last = lastReportTs.get(key) || 0;
  if (ts < last) return { ok: false, why: '上报时间戳回退（疑似重放）', strict: DEV_SECRET_STRICT };
  lastReportTs.set(key, ts);
  if (lastReportTs.size > 5000) lastReportTs.clear();
  return { ok: true };
}

/** 统一入口：验签不通过时按严格模式决定丢弃还是放行（兼容未升级固件） */
function guardReport(device, kind, msg) {
  const v = verifyDeviceSig(device, kind, msg);
  if (v.ok) return true;
  console.warn(`[SEC] ${device} ${kind} 上报被标记：${v.why}`);
  store.addEvent({ device, type: 'security', level: 'warn', text: `上报校验失败：${v.why}`, ts: Date.now() });
  return !DEV_SECRET_STRICT;   // 兼容模式：记录但放行；严格模式：丢弃
}

// 免登录白名单：健康检查、登录本身，以及「客户端查最新版本」——它只返回版本号和下载地址，
// 不含任何业务数据，且登录页也需要能提示升级。
const AUTH_EXEMPT = new Set(['/api/health', '/api/auth/login', '/api/app/version']);
app.use('/api', (req, res, next) => {
  const p = (req.originalUrl || req.url || '').split('?')[0];
  if (AUTH_EXEMPT.has(p)) return next();
  // 固件下载放行到接口内自行判定：允许「有效登录令牌」或「带过期的签名参数」（设备 OTA 无登录态）
  if (/^\/api\/firmwares\/[^/]+\/download$/.test(p)) return next();
  // 只认请求头，不接受 ?token=（URL 里的令牌会进访问日志、浏览器历史、截图，极易泄露）
  const u = verifyToken(req.get('X-Admin-Token') || '');
  if (!u) return res.status(401).json({ error: '未登录或登录已失效，请重新登录' });
  req.user = u;
  next();
});

app.post('/api/auth/login', (req, res) => {
  const account = String((req.body && req.body.account) || '').trim();
  const password = String((req.body && req.body.password) || '');
  if (loginLocked(account)) return res.status(429).json({ error: '失败次数过多，请 1 分钟后再试' });
  const u = store.getUser(account);
  if (!u || !verifyPassword(password, u.salt, u.hash)) { loginFail(account); return res.status(401).json({ error: '账号或密码错误' }); }
  if ((u.status || 'active') === 'paused') return res.status(403).json({ error: '该账号已被暂停，请联系管理员' });
  store.upsertUser({ account, lastLoginAt: Date.now() });
  loginFails.delete(account);
  res.json({ ok: true, token: signToken(account, u.role), account, role: u.role, name: u.name || '', expires: Date.now() + TOKEN_TTL_MS });
});
app.get('/api/auth/me', (req, res) => res.json({ ok: true, account: req.user.account, role: req.user.role, name: req.user.name }));
app.post('/api/auth/logout', (req, res) => res.json({ ok: true }));   // 无状态令牌：前端删本地 token 即可
// 所有登录用户：自己改密码
app.post('/api/auth/password', (req, res) => {
  const oldPwd = String((req.body && req.body.oldPassword) || '');
  const newPwd = String((req.body && req.body.newPassword) || '');
  if (newPwd.length < PWD_MIN || newPwd.length > PWD_MAX) return res.status(400).json({ error: '新密码需 6~64 位' });
  const u = store.getUser(req.user.account);
  if (!u || !verifyPassword(oldPwd, u.salt, u.hash)) return res.status(401).json({ error: '原密码错误' });
  const { salt, hash } = hashPassword(newPwd);
  store.upsertUser({ account: u.account, salt, hash });
  res.json({ ok: true });
});

/* ---- 用户管理（仅管理员） ---- */
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可操作' });
  next();
}
app.get('/api/users', requireAdmin, (req, res) => res.json({ users: store.listUsers() }));
app.post('/api/users', requireAdmin, (req, res) => {
  const account = String((req.body && req.body.account) || '').trim();
  const password = String((req.body && req.body.password) || '');
  const name = String((req.body && req.body.name) || '').trim();
  if (!ACCOUNT_RE.test(account)) return res.status(400).json({ error: '账号需 3~32 位字母/数字/下划线/中划线' });
  if (password.length < PWD_MIN || password.length > PWD_MAX) return res.status(400).json({ error: '密码需 6~64 位' });
  if (store.getUser(account)) return res.status(400).json({ error: '账号已存在：' + account });
  const { salt, hash } = hashPassword(password);
  store.upsertUser({ account, name: name || account, role: 'member', status: 'active', salt, hash, createdAt: Date.now(), lastLoginAt: 0 });
  res.json({ ok: true, account });
});
app.patch('/api/users/:account', requireAdmin, (req, res) => {
  const account = req.params.account;
  const u = store.getUser(account);
  if (!u) return res.status(404).json({ error: '账号不存在' });
  const patch = { account };
  if (typeof req.body.name === 'string') patch.name = req.body.name.trim();
  if (typeof req.body.status === 'string' && ['active', 'paused'].indexOf(req.body.status) >= 0) {
    if (account === ROOT_ADMIN && req.body.status === 'paused') return res.status(400).json({ error: '管理员账号不能被暂停' });
    patch.status = req.body.status;
  }
  if (typeof req.body.password === 'string') {
    if (req.body.password.length < PWD_MIN || req.body.password.length > PWD_MAX) return res.status(400).json({ error: '密码需 6~64 位' });
    const { salt, hash } = hashPassword(req.body.password);
    patch.salt = salt; patch.hash = hash;
  }
  store.upsertUser(patch);
  res.json({ ok: true, user: { account, name: patch.name !== undefined ? patch.name : u.name, role: u.role, status: patch.status || u.status || 'active' } });
});
app.delete('/api/users/:account', requireAdmin, (req, res) => {
  const account = req.params.account;
  if (!store.getUser(account)) return res.status(404).json({ error: '账号不存在' });
  if (account === ROOT_ADMIN) return res.status(400).json({ error: '管理员账号不能删除' });
  if (account === req.user.account) return res.status(400).json({ error: '不能删除自己' });
  store.removeUser(account);
  res.json({ ok: true });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
// WebSocket 同样鉴权：连接需带 ?token=<会话令牌>，否则立即关闭
wss.on('connection', (ws, req) => {
  let u = null;
  try { u = verifyToken(new URL(req.url, 'http://x').searchParams.get('token') || ''); } catch {}
  if (!u) { try { ws.close(4001, 'unauthorized'); } catch {} return; }
  ws.__user = u;
});

/* ---------------- 全局设置（AI + 工作流） ---------------- */
const NO_SETTINGS = {};
let settings = store.getSettings(NO_SETTINGS);
if (!settings.workflow || !settings.ai) {
  settings = {
    ai: { ...DEFAULT_AI },
    workflow: JSON.parse(JSON.stringify(DEFAULT_WORKFLOW)),
    workflowVersion: 1,
    updatedAt: Date.now()
  };
  store.saveSettings(settings);
}
function saveSettingsAndBroadcast() {
  settings.updatedAt = Date.now();
  store.saveSettings(settings);
  broadcast({ type: 'settings_update', data: getSettingsView() });
}
function getSettingsView() {
  return {
    ai: settings.ai,
    workflow: settings.workflow,
    workflowVersion: settings.workflowVersion,
    updatedAt: settings.updatedAt
  };
}

/* ---------------- MQTT 协议 ---------------- */
const PREFIX = config.mqtt.topicPrefix.endsWith('/') ? config.mqtt.topicPrefix : config.mqtt.topicPrefix + '/';

/** 从 topic 解析出 { device, kind }，如 dev/A001/status -> { A001, status } */
function parseTopic(topic) {
  if (!topic.startsWith(PREFIX)) return null;
  const rest = topic.slice(PREFIX.length); // A001/status
  const idx = rest.lastIndexOf('/');
  if (idx <= 0) return null;
  return { device: rest.slice(0, idx), kind: rest.slice(idx + 1) };
}

/** 指令签名：HMAC-SHA256(id|ts|nonce|cmd)，与固件 verifyCmdSig 同规则。
 * 未配置 CMD_SECRET 时不签名（固件侧同为兼容放行），配置后强制签。 */
function signCmd(device, payload) {
  const secret = config.mqtt.cmdSecret;
  if (!secret) return payload;
  const ts = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(6).toString('hex');
  const data = `${device}|${ts}|${nonce}|${payload.cmd || ''}`;
  const sig = crypto.createHmac('sha256', secret).update(data).digest('hex');
  return { ...payload, sig, ts, nonce };
}

function publishCmd(device, payload) {
  const dev = store.getDevice(device);
  const online = mqttClient && mqttClient.connected && dev && !!dev.online;
  mqttClient.publish(PREFIX + device + '/cmd', JSON.stringify(signCmd(device, payload)), { qos: 1 });
  return !!online;
}

/** 设备当前离线时返回中文提示（不阻断下发，仅告知用户可能无法确认执行结果） */
function offlineWarn(device) {
  const dev = store.getDevice(device);
  return (dev && !dev.online) ? '设备当前离线：指令已下发到消息代理，但主机未在线，无法确认执行结果（上线后如仍未执行，请重新下发）' : null;
}

/* ---------------- 设备状态处理 ---------------- */
/** 预置初始设备（首次启动自动注册；删除后不会被 MQTT 上报自动复活） */
function seedInitialDevices() {
  const map = store.getDevices();
  let changed = false;
  for (const id of config.initialDevices) {
    if (!map[id]) {
      store.upsertDevice({ id, meta: { name: '', note: '初始设备' }, createdAt: Date.now(), lastTs: 0, online: false });
      changed = true;
    }
  }
  if (changed) console.log(`[DEV] 初始设备已注册: ${config.initialDevices.join(', ')}`);
}
seedInitialDevices();

/** MQTT 上报是否来自已注册设备（未注册 → 忽略，保持"删除即移除"语义） */
function isKnownDevice(id) {
  return !!store.getDevice(id);
}

/** 指令执行回执：dev/{id}/ack —— 让后台确认「发下去的指令执行了没有」 */
function handleAck(device, msg) {
  const cmd = msg.cmd || '?';
  const ok = !!msg.ok;
  store.upsertDevice({ id: device, lastAck: { cmd, ok, detail: msg.detail || '', ts: msg.ts || null, tsConf: msg.tsConf || 'unset', at: Date.now() } });
  store.addEvent({ device, type: 'ack', level: ok ? 'info' : 'warn', text: `指令回执 ${cmd} ${ok ? '成功' : '失败'}${msg.detail ? '：' + msg.detail : ''}`, ts: Date.now() });
  console.log(`[ACK] ${device} ${cmd} ok=${ok}${msg.detail ? ' ' + msg.detail : ''}`);
}

/** 垃圾状态载荷告警节流（公共 broker 上可能有人往同名主题乱发，避免刷日志） */
const badStatusWarnAt = {};
function warnBadStatus(device, reason, msg) {
  const now = Date.now();
  if (now - (badStatusWarnAt[device] || 0) < 60000) return;
  badStatusWarnAt[device] = now;
  console.warn(`[MQTT] 丢弃${reason}（${device}）：${JSON.stringify(msg).slice(0, 100)}`);
}

/** 深度净化入站载荷：公共 broker 无鉴权，任何人都能往同名主题发消息。
 *  字符串一律截断并剔除尖括号，数字必须是有限数值，键名限定字符集，避免恶意载荷变成前端 HTML。 */
function deepSanitize(v, depth) {
  const d = depth || 0;
  if (d > 3) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.slice(0, 64).replace(/[<>]/g, '');
  if (Array.isArray(v)) return v.slice(0, 32).map((x) => deepSanitize(x, d + 1));
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).slice(0, 32)) {
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(k)) continue;
      o[k] = deepSanitize(v[k], d + 1);
    }
    return o;
  }
  return null;
}

function handleStatus(device, msg) {
  // 载荷校验：任何人都能往 broker 的同名主题发消息，垃圾载荷/冒名心跳不能污染设备状态
  // （典型症状：收到 {"online":0} 这类载荷后设备被永久显示"在线"，状态与真实完全脱钩）
  if (!msg || typeof msg !== 'object') return;
  if (msg.id != null && String(msg.id) !== device) return warnBadStatus(device, '冒名心跳（载荷 id 与主题不符）', msg);
  const recognizable = msg.state != null || msg.battery != null || msg.fw != null || msg.sensors != null;
  if (!recognizable) return warnBadStatus(device, '无法识别的状态载荷', msg);
  if (!guardReport(device, 'status', msg)) return;   // 上行验签：伪造的「设备在线」进不来

  // 入站载荷先净化再用（id 校验与可识别性判断在净化前完成，不受影响）
  msg = deepSanitize(msg) || {};

  const now = Date.now();
  const prev = store.getDevice(device);
  const wasOnline = prev ? !!prev.online : false;

  // 型号自动识别：设备自己在 status 里报 model 最可信；固件还没上报就沿用人工设置的
  const prevMeta = Object.assign({}, (prev && prev.meta) || {});
  const incomingModel = normalizeModelId(msg.model);
  if (incomingModel && prevMeta.model !== incomingModel) {
    prevMeta.model = incomingModel;
    prevMeta.modelSrc = 'device';
  }

  const rec = store.upsertDevice({
    id: device,
    meta: prevMeta,
    lastTs: now,
    online: true,
    lastSyncAt: new Date(now).toISOString(),
    snapshot: msg, // 最近一次状态快照（含 sensors / battery / state / fw）
    state: msg.state || (prev && prev.state) || 'unknown',
    battery: msg.battery,
    fw: msg.fw,
    volume: msg.volume != null ? msg.volume : (prev && prev.volume),
    workflowVersion: msg.workflow_version != null ? msg.workflow_version : (prev && prev.workflowVersion),
    sensorHealth: msg.sensors || (prev && prev.sensorHealth) || {},
    lastEvent: msg.last_event || (prev && prev.lastEvent) || null,
    // 开发者模式必须以「设备自己上报的 devmode」为准：
    // 固件 TTL 到期会自行关闭并上报 devmode=false，只看本地记录会让后台永远显示"开启中"（状态与实物脱钩）
    devmode: (typeof msg.devmode === 'boolean')
      ? msg.devmode
      : (prev && prev.devmode ? true : false),
    devmodeUntil: (msg.devmode === false)
      ? 0
      : (prev && prev.devmodeUntil ? prev.devmodeUntil : 0)
  });

  // 全局推送闭环：设备上报的工作流版本落后于全局版本（离线期间错过推送）→ 自动补发
  if (msg.workflow_version != null && Number(msg.workflow_version) !== settings.workflowVersion) {
    publishCmd(device, {
      cmd: 'set_workflow',
      version: settings.workflowVersion,
      workflow: settings.workflow,
      ai: { enabled: settings.ai.enabled, model: settings.ai.model, endpoint: settings.ai.endpoint, timeoutSec: settings.ai.timeoutSec }
    });
    console.log(`[WF] 设备 ${device} 工作流 v${msg.workflow_version} 落后于全局 v${settings.workflowVersion}，已自动补发`);
  }

  if (!wasOnline) {
    store.addEvent({ device, type: 'device', level: 'info', text: '设备上线（收到心跳）', ts: now });
  }

  broadcast({ type: 'device_update', device, data: rec });

  // 开发者模式期间：高频 status 即实时数据流，前端靠 WS 刷新
  if (rec.devmode) {
    broadcast({ type: 'live', device, data: msg });
  }
}

function handleEvent(device, msg) {
  if (!guardReport(device, 'event', msg)) return;
  // 事件时间一律以服务端时间为准：真机固件上报的 ts 是运行毫秒数（millis），不是 Unix 时间戳，
  // 直接采用会导致事件时间错乱（显示 1970 年、排序异常）。
  const now = Date.now();
  const level = msg.level || 'info';
  store.addEvent({ device, type: msg.type || 'event', level, text: msg.text || '', ts: now });
  store.upsertDevice({ id: device, lastEvent: msg.type || 'event' });
  broadcast({ type: 'event', device, data: { type: msg.type, level, text: msg.text, ts: now } });
}

function handleDiag(device, msg) {
  if (!guardReport(device, 'diag', msg)) return;
  const analysis = analyzeDiag(msg.items || []);
  // 可选 AI 增强（使用后台「AI 与工作流」页可编辑的 settings.ai；失败不影响主流程）
  const aiCfg = settings.ai;
  if (analysis.result === 'fail' && aiCfg && aiCfg.enabled && aiCfg.apiKey && aiCfg.endpoint) {
    enhanceWithAI(device, analysis).catch(() => {});
  }
  // 自检时间以服务端为准（原因同上：真机固件 ts 为运行毫秒数）
  // 存归一化后的对象数组：前端直接读 name/status/code，不用再解一次字符串
  const items = insightsDiagItems(msg.items);
  store.upsertDevice({ id: device, lastDiag: { ts: Date.now(), seq: msg.seq, items, ...analysis } });
  broadcast({ type: 'diag', device, data: { seq: msg.seq, items, ...analysis } });
}

/** 心跳超时离线扫描（每 5 秒；固件常态心跳 60 秒） */
setInterval(() => {
  const now = Date.now();
  const map = store.getDevices();
  let changed = false;
  for (const id of Object.keys(map)) {
    const d = map[id];
    // lastTs 缺失（老数据/异常记录）时按 0 处理，否则 now-NaN 比较恒为 false → 永不判离线
    const lastTs = Number(d.lastTs) || 0;
    // OTA 下载/重启期间固件无心跳（1.1MB 慢网可超过离线阈值），宽限期内不判离线
    const grace = Number(d.otaGraceUntil) || 0;
    if (grace) {
      if (now < grace) continue;              // 宽限进行中：保持在线态
      store.upsertDevice({ id, otaGraceUntil: 0 });  // 宽限已过：清掉标记，恢复正常判定
    }
    if (d.online && now - lastTs > config.offlineAfterMs) {
      store.upsertDevice({ id, online: false });
      store.addEvent({ device: id, type: 'device', level: 'warn', text: '设备离线（心跳超时）', ts: now });
      broadcast({ type: 'device_update', device: id, data: store.getDevice(id) });
      changed = true;
    }
    // 开发者模式 TTL 到期 → 自动关闭
    if (d.devmode && d.devmodeUntil && now > d.devmodeUntil) {
      publishCmd(id, { cmd: 'devmode', on: false });
      store.upsertDevice({ id, devmode: false, devmodeUntil: 0 });
      store.addEvent({ device: id, type: 'devmode', level: 'info', text: '开发者模式超时自动关闭，主机已恢复低功耗', ts: now });
      broadcast({ type: 'devmode', device: id, data: { on: false, reason: 'timeout' } });
      changed = true;
    }
  }
  if (changed) broadcast({ type: 'devices_sync' });
}, 10000);

/* ---------------- 可选 AI 故障增强（统一使用后台可改的 settings.ai 配置） ---------------- */
async function enhanceWithAI(device, analysis) {
  const ai = settings.ai;
  if (!ai || !ai.enabled || !ai.apiKey || !ai.endpoint) return;
  const prompt =
    '厨房AI安全提醒仪传感器自检发现故障，请用两三句话给出最可能的故障原因与排查建议（中文）：\n' +
    JSON.stringify(analysis.problems, null, 2);
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), (ai.timeoutSec || 8) * 1000);
    const resp = await fetch(ai.endpoint, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + ai.apiKey
      },
      body: JSON.stringify({
        model: ai.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 300
      })
    });
    clearTimeout(timer);
    const data = await resp.json();
    const summary = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (summary) {
      store.upsertDevice({ id: device, lastDiag: { ...store.getDevice(device).lastDiag, aiSummary: summary } });
      broadcast({ type: 'diag_ai', device, data: { summary } });
    }
  } catch (e) {
    console.warn('[AI] 自检增强失败（跳过，不影响自检结果）:', e.message);
  }
}

/* ---------------- 场景 AI 判断（云端代理 + 规则兜底） ---------------- */
/**
 * 主机在开发者模式/检测触发时上传场景快照（dev/{id}/snap），后台负责：
 *  1. 若配置了云端大模型 → 调用 AI 判断「是否厨房使用场景」并给出置信度；
 *  2. 未配置 / 调用失败 → 用本地规则引擎（runWorkflow）兜底，0 成本。
 * 判定结果回发 dev/{id}/ai，主机按结果决定是否执行燃气检测。
 */
async function callSceneAI(device, sensors, ctx) {
  const ai = settings.ai;
  if (ai && ai.enabled && ai.apiKey && ai.endpoint) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), (ai.timeoutSec || 8) * 1000);
      const prompt =
        '你是厨房安全检测仪的 AI 判断器。根据传感器快照判断厨房是否正在被使用（人在厨房且有做饭迹象）。' +
        '只输出 JSON：{"cooking":true/false,"confidence":0-1,"reason":"一句话"}。\n传感器数据：' +
        JSON.stringify({ sensors, personPresent: ctx.personPresent });
      const resp = await fetch(ai.endpoint, {
        method: 'POST',
        signal: ac.signal,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ai.apiKey },
        body: JSON.stringify({
          model: ai.model,
          temperature: ai.temperature,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 200,
          response_format: { type: 'json_object' }
        })
      });
      clearTimeout(timer);
      const data = await resp.json();
      const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (content) {
        const parsed = JSON.parse(content);
        return {
          source: 'ai',
          cooking: !!parsed.cooking,
          confidence: Number(parsed.confidence) || 0.5,
          reason: parsed.reason || '（模型未给出原因）'
        };
      }
    } catch (e) {
      console.warn('[AI] 云端判断失败，降级规则引擎:', e.message);
    }
  }
  // 规则引擎兜底：cooking = 人在场 + 有热源/做饭迹象（光线在点亮范围 或 MQ 有尖峰 或 温度偏高）
  const r = runWorkflow(sensors, ctx, settings.workflow);
  const personPresent = !!ctx.personPresent;
  const heatLike = (Number(sensors.light || 0) >= 20 && Number(sensors.light || 0) <= 3000) ||
                   (Number(sensors.mq || 0) > 800) ||
                   (Number((sensors.sht && sensors.sht.t) || 0) >= 26);
  const cooking = personPresent && heatLike;
  return {
    source: 'rule',
    cooking,
    confidence: 0.6,
    reason: cooking
      ? '本地规则引擎判定：人在厨房且有做饭迹象（光线/温度/燃气读数）'
      : '本地规则引擎判定：无人或无做饭迹象，未进入做饭态'
  };
}

/* 主机场景快照 → 判断 → 回发 dev/{id}/ai */
function handleSnap(device, msg) {
  if (!guardReport(device, 'snap', msg)) return;
  const sensors = msg.sensors || {};
  const ctx = {
    personPresent: !!((sensors.radar && sensors.radar.presence) || msg.personPresent),
    cooking: !!msg.cooking,
    sinceCookStartSec: Number(msg.sinceCookStartSec || 0)
  };

  // 状态迁移落事件：只有「变化」才写，避免 20 秒一条的快照把事件流灌满。
  // 用户数据库的做饭时段/时长/离厨统计全靠这四个迁移点，没有它算不出任何真实数据。
  const prevSnap = (store.getDevice(device) || {}).lastSnapCtx;
  const nowTs = Date.now();
  if (prevSnap) {
    if (!!prevSnap.personPresent !== ctx.personPresent) {
      store.addEvent({
        device, type: 'presence', level: 'info',
        text: ctx.personPresent ? '有人进入厨房' : '离开厨房', ts: nowTs
      });
    }
    if (!!prevSnap.cooking !== ctx.cooking) {
      store.addEvent({
        device, type: 'cook', level: 'info',
        text: ctx.cooking ? '开始做饭' : '结束做饭', ts: nowTs
      });
    }
  }
  store.upsertDevice({ id: device, lastSnapCtx: { personPresent: ctx.personPresent, cooking: ctx.cooking, at: nowTs } });

  callSceneAI(device, sensors, ctx).then((result) => {
    const payload = { id: device, ts: Date.now(), seq: msg.seq || 0, ...result };
    mqttClient.publish(PREFIX + device + '/ai', JSON.stringify(payload), { qos: 1 });
    broadcast({ type: 'ai', device, data: payload });
  }).catch(() => {});
}

/* ---------------- WebSocket 广播 ---------------- */
function broadcast(payload) {
  const text = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      try { client.send(text); } catch (e) { /* 单个客户端异常不影响其他客户端 */ }
    }
  }
}

/* ---------------- REST API ---------------- */
const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
function deviceParam(req, res, next) {
  const id = req.params.id;
  if (!ID_RE.test(id)) return res.status(400).json({ error: '非法设备 ID' });
  req.deviceId = id;
  next();
}

// 设备总览：所有 ID 的运行状态（在线/离线/最后同步/状态/电池/固件/开发者模式）
app.get('/api/devices', (req, res) => {
  const map = store.getDevices();
  const list = Object.keys(map).map((id) => {
    const d = map[id];
    return {
      id,
      name: d.meta && d.meta.name,
      note: d.meta && d.meta.note,
      userName: d.meta && d.meta.userName,
      userPhone: d.meta && d.meta.userPhone,
      deviceAddr: d.meta && d.meta.deviceAddr,
      ...modelOf(d.meta),
      mac: (d.meta && d.meta.mac) || null,
      createdAt: d.createdAt || 0,
      volume: d.volume != null ? d.volume : null,
      online: !!d.online,
      state: d.state,
      battery: d.battery,
      fw: d.fw,
      workflowVersion: d.workflowVersion != null ? d.workflowVersion : null,
      lastSyncAt: d.lastSyncAt,
      lastSyncTs: d.lastTs,
      sensorHealth: d.sensorHealth,
      devmode: !!d.devmode,
      devmodeUntil: d.devmodeUntil || 0,
      lastEvent: d.lastEvent,
      lastDiagResult: d.lastDiag ? d.lastDiag.result : null,
      lastDiagAt: d.lastDiag ? d.lastDiag.ts : 0
    };
  });
  res.json({ devices: list });
});

/* 型号清单：前端据此渲染下拉（后两个待开发，disabled） */
app.get('/api/models', (req, res) => {
  res.json({ ok: true, models: DEVICE_MODELS, default: DEFAULT_MODEL });
});

/* 设置某台主机的型号：只接受可用型号，待开发型号一律拒绝 */
app.post('/api/devices/:id/model', (req, res) => {
  const id = req.params.id;
  const dev = store.getDevice(id);
  if (!dev) return res.status(404).json({ error: '设备不存在' });
  const want = normalizeModelId(req.body && req.body.model);
  if (!want) return res.status(400).json({ error: '未知型号，请从型号列表中选择' });
  const m = DEVICE_MODELS.find((x) => x.id === want);
  if (!m.available) return res.status(400).json({ error: '型号「' + m.name + '」尚未开发完成，暂不能选择' });
  const meta = Object.assign({}, dev.meta || {});
  meta.model = want;
  meta.modelSrc = 'manual';
  store.upsertDevice({ id, meta });
  store.addEvent({ device: id, type: 'params', level: 'info', text: '型号设置为 ' + m.name, ts: Date.now() });
  broadcast({ type: 'devices_sync' });
  res.json({ ok: true, model: want, modelName: m.name });
});

// 单设备详情：状态快照 + 最近事件
app.get('/api/devices/:id', deviceParam, (req, res) => {
  const d = store.getDevice(req.deviceId);
  if (!d) return res.json({ device: null });
  res.json({
    device: {
      id: d.id,
      name: d.meta && d.meta.name,
      note: d.meta && d.meta.note,
      userName: d.meta && d.meta.userName,
      userPhone: d.meta && d.meta.userPhone,
      deviceAddr: d.meta && d.meta.deviceAddr,
      ...modelOf(d.meta),
      mac: (d.meta && d.meta.mac) || null,
      createdAt: d.createdAt || 0,
      volume: d.volume != null ? d.volume : null,
      online: !!d.online,
      state: d.state,
      battery: d.battery,
      fw: d.fw,
      workflowVersion: d.workflowVersion != null ? d.workflowVersion : null,
      lastSyncAt: d.lastSyncAt,
      lastSyncTs: d.lastTs,
      sensorHealth: d.sensorHealth,
      snapshot: d.snapshot,
      devmode: !!d.devmode,
      devmodeUntil: d.devmodeUntil || 0,
      lastEvent: d.lastEvent,
      lastDiag: d.lastDiag || null,
      otaGraceUntil: d.otaGraceUntil || 0,
      otaStartedAt: d.otaStartedAt || 0,
      otaTargetVersion: d.otaTargetVersion || null,
      lastAck: d.lastAck || null
    },
    events: store.listEvents(req.deviceId, 30)
  });
});

/* ---------------- 设备管理（添加 / 改名 / 删除） ---------------- */

/** 设备端触发参数合法范围（下发前钳制/过滤，防止无效值写入真机） */
const DEV_PARAM_LIMITS = {
  fire_detect_window: [5, 600],      // 点火检测窗口（秒）
  fire_sigma: [1, 20],               // 点火尖峰标准差倍数
  leak_confirm_sec: [1, 600],        // 泄漏确认窗口（秒）
  steam_exclude_sec: [1, 600],       // 蒸汽排除时长（秒）
  remind_interval_sec: [10, 3600],   // 忘关火提醒间隔（秒）
  stove_timeout_sec: [10, 7200],     // 连续无人阈值（秒）
  pet_confirm_sec: [10, 3600],       // 宠物排除确认窗口（秒）
  low_battery_v: [2.5, 4.5]          // 低电报警电压（伏）
};
function sanitizeDeviceParams(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const k of Object.keys(raw)) {
    const lim = DEV_PARAM_LIMITS[k];
    if (!lim) continue; // 未知参数直接丢弃，不写入真机
    const n = Number(raw[k]);
    if (!Number.isFinite(n)) continue;
    out[k] = Math.min(Math.max(n, lim[0]), lim[1]);
  }
  return out;
}

// 添加设备：{ id?, name?, note? }；id 不填自动生成（D 前缀递增）
app.post('/api/devices', (req, res) => {
  let id = (req.body && req.body.id || '').toString().trim();
  if (!id) {
    // 默认规则：A + 年份(4位) + 日期(MMDD) + 当天编号(4位)，如 A202610310001
    const map = store.getDevices();
    const now = new Date();
    const d = now.getFullYear().toString() +
      String(now.getMonth() + 1).padStart(2, '0') +
      String(now.getDate()).padStart(2, '0');
    const prefix = 'A' + d;
    const used = new Set(Object.keys(map).filter((k) => k.startsWith(prefix)));
    let n = 1;
    while (used.has(prefix + String(n).padStart(4, '0'))) n++;
    id = prefix + String(n).padStart(4, '0');
  }
  if (!ID_RE.test(id)) return res.status(400).json({ error: '设备 ID 仅支持字母/数字/下划线/中划线，1~32 位' });
  if (store.getDevice(id)) return res.status(400).json({ error: '设备 ID 已存在：' + id });
  // 型号：不传则用默认；传了就必须是已开放的型号，待开发的不能写进来
  let modelToSave = DEFAULT_MODEL;
  if (req.body && req.body.model) {
    const want = normalizeModelId(req.body.model);
    const mi = want ? DEVICE_MODELS.find((x) => x.id === want) : null;
    if (!mi) return res.status(400).json({ error: '未知型号，请从型号列表中选择' });
    if (!mi.available) return res.status(400).json({ error: '型号「' + mi.name + '」尚未开发完成，暂不能选择' });
    modelToSave = want;
  }
  const rec = store.upsertDevice({
    id,
    meta: {
      name: (req.body && req.body.name || '').toString(),
      note: (req.body && req.body.note || '手动添加').toString(),
      userName: (req.body && req.body.userName || '').toString().trim(),
      userPhone: (req.body && req.body.userPhone || '').toString().trim(),
      deviceAddr: (req.body && req.body.deviceAddr || '').toString().trim(),
      model: modelToSave,
      modelSrc: 'manual',
      mac: (req.body && req.body.mac || '').toString().trim().toUpperCase() || null
    },
    createdAt: Date.now(),
    lastTs: 0,
    online: false
  });
  store.addEvent({ device: id, type: 'device', level: 'info', text: '设备已添加（后台注册）', ts: Date.now() });
  broadcast({ type: 'devices_sync' });
  res.json({ ok: true, device: { id, name: rec.meta.name, note: rec.meta.note, userName: rec.meta.userName, userPhone: rec.meta.userPhone, deviceAddr: rec.meta.deviceAddr, mac: rec.meta.mac, ...modelOf(rec.meta), createdAt: rec.createdAt } });
});

// 修改设备信息（名称 / 备注 / 使用者姓名 / 电话 / 地址）
app.patch('/api/devices/:id', deviceParam, (req, res) => {
  const d = store.getDevice(req.deviceId);
  if (!d) return res.status(404).json({ error: '设备不存在' });
  const meta = Object.assign({}, d.meta || {});
  if (typeof req.body.name === 'string') meta.name = req.body.name;
  if (typeof req.body.note === 'string') meta.note = req.body.note;
  if (typeof req.body.userName === 'string') meta.userName = req.body.userName.trim();
  if (typeof req.body.userPhone === 'string') meta.userPhone = req.body.userPhone.trim();
  if (typeof req.body.deviceAddr === 'string') meta.deviceAddr = req.body.deviceAddr.trim();
  store.upsertDevice({ id: req.deviceId, meta });
  broadcast({ type: 'devices_sync' });
  res.json({ ok: true, id: req.deviceId, meta });
});

// 删除设备：从设备库移除，MQTT 上报不再自动注册
app.delete('/api/devices/:id', deviceParam, (req, res) => {
  if (!store.getDevice(req.deviceId)) return res.status(404).json({ error: '设备不存在' });
  store.removeDevice(req.deviceId);
  store.addEvent({ device: req.deviceId, type: 'device', level: 'warn', text: '设备已从后台删除', ts: Date.now() });
  broadcast({ type: 'devices_sync' });
  res.json({ ok: true, deleted: req.deviceId });
});

// 音量下发：{ volume: 0~100 } → 主机调整播报音量（真实生效于 I2S 功放）
app.post('/api/devices/:id/volume', deviceParam, (req, res) => {
  const vol = Number(req.body && req.body.volume);
  if (!Number.isFinite(vol) || vol < 0 || vol > 100) return res.status(400).json({ error: '音量必须是 0~100 的数字' });
  publishCmd(req.deviceId, { cmd: 'set_volume', volume: Math.round(vol) });
  res.json({ ok: true, device: req.deviceId, volume: Math.round(vol), warn: offlineWarn(req.deviceId) });
});

// WiFi 配置下发：{ ssid, pass? } → 主机保存并连接
app.post('/api/devices/:id/wifi', deviceParam, (req, res) => {
  const { ssid, pass } = req.body || {};
  if (!ssid || !String(ssid).trim()) return res.status(400).json({ error: '缺少 SSID' });
  if (String(ssid).length > 32 || (pass && String(pass).length > 64)) return res.status(400).json({ error: 'SSID ≤32 位，密码 ≤64 位' });
  publishCmd(req.deviceId, { cmd: 'set_wifi', ssid: String(ssid).trim(), pass: pass ? String(pass) : '' });
  store.addEvent({ device: req.deviceId, type: 'wifi', level: 'info', text: `已下发 WiFi 配置：${String(ssid).trim()}`, ts: Date.now() });
  res.json({ ok: true, ssid: String(ssid).trim(), warn: offlineWarn(req.deviceId) });
});

/* ---------------- 固件库（程序上传 / 管理 / 下载） ---------------- */

// 固件列表
app.get('/api/firmwares', (req, res) => {
  res.json({ firmwares: store.getFirmwares() });
});

// 上传固件：请求体为 .bin 原始字节；文件名/版本/备注放请求头
app.post('/api/firmwares/upload', express.raw({ type: '*/*', limit: '8mb' }), (req, res) => {
  const name = (req.get('X-Fw-Name') || 'firmware').replace(/[^\w.\- ]/g, '').slice(0, 60);
  const version = (req.get('X-Fw-Version') || '0.0.0').replace(/[^\w.\-]/g, '').slice(0, 24);
  const note = (req.get('X-Fw-Note') || '').toString().slice(0, 120);
  if (!req.body || !req.body.length) return res.status(400).json({ error: '固件内容为空' });
  if (req.body.length < 16) return res.status(400).json({ error: '文件过小，不是有效固件' });
  const id = crypto.randomBytes(4).toString('hex');
  const fileName = `${id}_${name}_v${version}.bin`;
  if (!fs.existsSync(config.firmwareDir)) fs.mkdirSync(config.firmwareDir, { recursive: true });
  fs.writeFileSync(path.join(config.firmwareDir, fileName), req.body);
  const sha256 = crypto.createHash('sha256').update(req.body).digest('hex');
  const fw = {
    id, name, version, note,
    size: req.body.length,
    sha256,
    fileName,
    uploadedAt: Date.now()
  };
  const list = store.getFirmwares();
  list.unshift(fw);
  store.saveFirmwares(list);
  res.json({ ok: true, firmware: fw, downloadUrl: '/api/firmwares/' + id + '/download' });
});

// 删除固件
// 取一个带签名的临时下载地址（已登录才可换）
app.get('/api/firmwares/:id/link', (req, res) => {
  if (!store.getFirmware(req.params.id)) return res.status(404).json({ error: '固件不存在' });
  const exp = Date.now() + 30 * 60 * 1000;
  const url = signedFwUrl(req.params.id, '', 30);
  res.json({ ok: true, url, expiresAt: exp });
});

app.delete('/api/firmwares/:id', (req, res) => {
  if (!store.removeFirmware(req.params.id)) return res.status(404).json({ error: '固件不存在' });
  res.json({ ok: true, deleted: req.params.id });
});

// 下载固件（同时作为 OTA 下载地址）：需登录令牌，或带过期的签名参数
app.get('/api/firmwares/:id/download', (req, res) => {
  const authed = !!verifyToken(req.get('X-Admin-Token') || '');
  if (!authed && !fwUrlOk(req.params.id, req.query)) {
    return res.status(401).json({ error: '需要登录，或使用带有效签名的下载链接' });
  }
  const fw = store.getFirmware(req.params.id);
  if (!fw) return res.status(404).json({ error: '固件不存在' });
  const file = path.resolve(config.firmwareDir, fw.fileName);
  if (!fs.existsSync(file)) return res.status(404).json({ error: '固件文件缺失' });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fw.fileName)}"`);
  res.sendFile(file);
});

// 事件历史（limit 钳制 1~2000，防超大请求拖慢排序）
/* ---------------- 用户数据库：主机使用情况分析 ---------------- */
/** 总览：设备清单 + 事件分布（小时/天）+ 数据覆盖说明 */
app.get('/api/insights/overview', (req, res) => {
  // days=0 表示「全部」：从最早一条事件算起；1~30 为窗口天数
  const raw = parseInt(req.query.days, 10);
  const days = raw === 0 ? 0 : Math.min(30, Math.max(1, raw || 7));
  const modelId = String(req.query.model || '').trim();
  res.json(insights.buildOverview(store, days, modelId));
});

/** 单机明细：事件时间线、活跃时段、离线间隔（由事件间隔推断） */
app.get('/api/insights/devices/:id', (req, res) => {
  const d = insights.buildDeviceDetail(store, req.params.id, 200);
  if (!d) return res.status(404).json({ error: '设备不存在' });
  res.json(d);
});

/** 由真实数据生成的调试建议（每条都能指回具体事件） */
app.get('/api/insights/suggestions', (req, res) => {
  res.json(insights.buildSuggestions(store, 7));
});

/** 云端调参知识库：每次下发过的调试动作都留档，便于回溯「改了什么、影响了几台」 */
/* ---------------- 设备型号 ---------------- */
/* 只有 available:true 的型号能被选；其余在界面上显示「待开发」且后端拒收，
 * 避免有人绕过前端把设备标成还没做出来的型号。 */
const DEVICE_MODELS = [
  { id: 'zilo-wa-v1', code: 'ZILO-WA-V1', name: 'ZILO 无线报警V1', available: true, note: '当前可量产，支持无线报警与联网上报' },
  { id: 'zilo-wa-slave-v1', code: 'ZILO-WA-SLAVE-V1', name: 'ZILO 无线报警带从站V1', available: false, note: '待开发' },
  { id: 'zilo-wired-cut-v1', code: 'ZILO-WIRED-CUT-V1', name: 'ZILO 有线切断V1', available: false, note: '待开发' },
];
const DEFAULT_MODEL = 'zilo-wa-v1';

/** 设备上报的型号可能是 code / id / 中文名，统一归一成 id；认不出就返回 null（不瞎猜） */
function normalizeModelId(v) {
  if (!v) return null;
  const raw = String(v).trim();
  if (!raw) return null;
  const hit = DEVICE_MODELS.find((m) =>
    raw.toLowerCase() === m.id.toLowerCase() ||
    raw.toUpperCase() === m.code.toUpperCase() ||
    raw === m.name);
  return hit ? hit.id : null;
}
function modelOf(meta) {
  const id = normalizeModelId(meta && meta.model) || '';
  const m = DEVICE_MODELS.find((x) => x.id === id);
  return {
    model: id || null,
    modelName: m ? m.name : null,
    modelAvailable: m ? m.available : false,
    modelSrc: (meta && meta.modelSrc) || (m ? 'manual' : 'unknown'),
  };
}

/* ---------------- 无线测试（实机现场验证） ----------------
 * 开发者到厨房现场，逐项模拟场景（人靠近/离开、燃气、声音、按键…），
 * 记录「是否误报 / 是否漏报 / 数值是否对」，系统据此给整改建议。
 * 记录全部落在 settings.wirelessTests，最多保留 100 场。 */
const TEST_KEY = 'wirelessTests';

/** 本地（UTC+8）日期 YYYY-MM-DD */
function fmtDay(ts) {
  const d = new Date((ts || Date.now()) + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}


/** 可测项目：与固件真正具备的输入通道一一对应 */
const TEST_ITEMS = [
  { id: 'presence', name: '人体存在（雷达）', scene: '人进入厨房区域', kind: 'sensor' },
  { id: 'dist', name: '人体距离（雷达）', scene: '人走到 1m / 2m / 3m 处', kind: 'sensor' },
  { id: 'gas', name: '可燃气体（MQ）', scene: '打火机放气靠近（勿点燃）', kind: 'sensor' },
  { id: 'mic', name: '声音强度（麦克风）', scene: '正常说话 / 大声喊', kind: 'sensor' },
  { id: 'light', name: '光照', scene: '开灯 / 关灯 / 遮挡', kind: 'sensor' },
  { id: 'temp', name: '温度', scene: '手捂探头 / 靠近热源', kind: 'sensor' },
  { id: 'humid', name: '湿度', scene: '对着探头哈气', kind: 'sensor' },
  { id: 'voice', name: '扬声器/语音', scene: '触发报警听取提示音', kind: 'output' },
  { id: 'key', name: '按键', scene: '短按 / 长按 3 秒', kind: 'input' },
  { id: 'report', name: '联网与上报', scene: '断电重连、观察后台是否收到', kind: 'net' },
  { id: 'power', name: '断电与恢复', scene: '拔电 10 秒再上电', kind: 'net' },
];

const TEST_RESULTS = ['ok', 'noise', 'miss', 'value'];
const RESULT_LABEL = { ok: '正常', noise: '误报', miss: '漏报', value: '数值不对' };

function wirelessTests() {
  return Array.isArray(settings[TEST_KEY]) ? settings[TEST_KEY] : [];
}

/** 根据记录里的失败项给整改建议（规则明确，可追溯到具体条目） */
function testAdvice(items) {
  const by = {};
  items.forEach((it) => { (by[it.item] = by[it.item] || []).push(it); });
  const advice = [];
  Object.keys(by).forEach((itemId) => {
    const list = by[itemId];
    const info = TEST_ITEMS.find((x) => x.id === itemId) || { name: itemId };
    const miss = list.filter((x) => x.result === 'miss').length;
    const noise = list.filter((x) => x.result === 'noise').length;
    const value = list.filter((x) => x.result === 'value').length;
    const ok = list.filter((x) => x.result === 'ok').length;
    if (!miss && !noise && !value) return;
    const parts = [];
    if (miss) parts.push('漏报 ' + miss + ' 次');
    if (noise) parts.push('误报 ' + noise + ' 次');
    if (value) parts.push('数值异常 ' + value + ' 次');
    let fix = '';
    if (miss && !noise) fix = '判定条件偏严：放宽阈值或缩短确认时间（如 presence 的 holdMs 从 3000 降到 1500），并确认探头供电与接线';
    else if (noise && !miss) fix = '判定条件偏松：加大去抖与连续命中次数，或抬高触发阈值（如 gas 的 mq 阈值上调 10%~15%）';
    else if (miss && noise) fix = '判定区间过窄：存在「该响不响、不该响乱响」，需重新定标阈值上下限，并检查传感器安装位置与遮挡';
    else if (value) fix = '读数与现场不符：优先怀疑校准与接线（供电电压、探头接触），再核对上报字段单位';
    advice.push({
      item: itemId,
      name: info.name,
      scene: info.scene || '',
      failCount: miss + noise + value,
      okCount: ok,
      detail: parts.join('，'),
      fix,
      level: (miss + noise + value) >= 2 ? 'high' : 'mid',
    });
  });
  return advice.sort((a, b) => b.failCount - a.failCount);
}

/** 测试列表（概要，不带完整条目） */
app.get('/api/tests', (req, res) => {
  const device = String(req.query.device || '');
  const list = wirelessTests()
    .filter((t) => !device || t.device === device)
    .slice()
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
    .map((t) => ({
      id: t.id, device: t.device, deviceName: t.deviceName, date: t.date,
      tester: t.tester, startedAt: t.startedAt, finishedAt: t.finishedAt || 0,
      status: t.status, count: (t.items || []).length,
      failCount: (t.items || []).filter((i) => i.result !== 'ok').length,
    }));
  res.json({ ok: true, total: list.length, tests: list, items: TEST_ITEMS });
});

/** 新建一场测试 */
app.post('/api/tests', (req, res) => {
  const b = req.body || {};
  const device = String(b.device || '').trim();
  if (!device) return res.status(400).json({ error: '请选择设备' });
  const d = store.getDevice(device);
  if (!d) return res.status(400).json({ error: '设备不存在：' + device });
  const tester = String(b.tester || '').trim();
  if (!tester) return res.status(400).json({ error: '请填写测试人员' });
  const date = String(b.date || '').slice(0, 10) || fmtDay(Date.now());
  const rec = {
    id: 'T' + Date.now().toString(36).toUpperCase(),
    device,
    deviceName: (d.meta && d.meta.name) || '',
    date,
    tester,
    startedAt: Date.now(),
    finishedAt: 0,
    status: 'running',
    items: [],
  };
  // 真联动：测试期间把主机切到开发者模式（5 秒一次高频上报），前端才能取到实时读数
  let linkWarn = '';
  if (d.online) {
    publishCmd(device, { cmd: 'devmode', on: true, ttl: 3600 });
    store.upsertDevice({ id: device, devmode: true, devmodeUntil: Date.now() + 3600 * 1000 });
    rec.linked = true;
    rec.linkedAt = Date.now();
  } else {
    rec.linked = false;
    linkWarn = '主机当前离线，已开始记录，但拿不到实时读数；主机联网后自动恢复联动';
  }
  settings[TEST_KEY] = [rec].concat(wirelessTests()).slice(0, 100);
  store.saveSettings(settings);
  res.json({ ok: true, test: rec, items: TEST_ITEMS, linked: rec.linked, warn: linkWarn || offlineWarn(device) });
});

/** 测试联动：拉取被测主机当前实时读数（前端 2 秒轮询，数值来自主机真实上报） */
app.get('/api/tests/:id/live', (req, res) => {
  const t = wirelessTests().find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: '测试记录不存在' });
  const d = store.getDevice(t.device);
  if (!d) return res.json({ ok: true, online: false, reason: '设备已删除，联动中断' });
  const now = Date.now();
  const lastTs = Number(d.lastTs) || 0;
  const ageSec = lastTs ? Math.round((now - lastTs) / 1000) : null;
  const snap = d.snapshot || {};
  res.json({
    ok: true,
    device: t.device,
    deviceName: (d.meta && d.meta.name) || '',
    online: !!d.online && ageSec != null && ageSec <= Math.round(config.offlineAfterMs / 1000),
    ageSec,
    devmode: !!d.devmode,
    sensors: snap.sensors || {},
    battery: snap.battery != null ? snap.battery : (d.battery != null ? d.battery : null),
    state: snap.state || d.state || 'unknown',
    fw: snap.fw || d.fw || '',
    ts: lastTs
  });
});

/** 追加一条验证记录 */
app.post('/api/tests/:id/items', (req, res) => {
  const t = wirelessTests().find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: '测试记录不存在' });
  if (t.status === 'done') return res.status(400).json({ error: '这场测试已结束，不能再追加' });
  const b = req.body || {};
  const item = String(b.item || '');
  if (!TEST_ITEMS.some((x) => x.id === item)) return res.status(400).json({ error: '未知测试项' });
  const result = String(b.result || '');
  if (!TEST_RESULTS.includes(result)) return res.status(400).json({ error: '结果只能是 正常/误报/漏报/数值不对' });
  t.items.push({
    at: Date.now(), item, result,
    value: String(b.value || '').slice(0, 60),
    note: String(b.note || '').slice(0, 300),
  });
  store.saveSettings(settings);
  res.json({ ok: true, test: t, advice: testAdvice(t.items) });
});

/** 结束一场测试并给出建议 */
app.post('/api/tests/:id/finish', (req, res) => {
  const t = wirelessTests().find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: '测试记录不存在' });
  t.status = 'done';
  t.finishedAt = Date.now();
  // 测试结束，主机退出开发者模式，回常态省电心跳
  const d = store.getDevice(t.device);
  if (d && d.devmode) {
    publishCmd(t.device, { cmd: 'devmode', on: false });
    store.upsertDevice({ id: t.device, devmode: false, devmodeUntil: 0 });
  }
  store.saveSettings(settings);
  res.json({ ok: true, test: t, advice: testAdvice(t.items) });
});

/** 单场详情 */
app.get('/api/tests/:id', (req, res) => {
  const t = wirelessTests().find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: '测试记录不存在' });
  res.json({ ok: true, test: t, advice: testAdvice(t.items), allItems: TEST_ITEMS });
});

/** 删除一场（谨慎操作，需显式确认参数） */
app.delete('/api/tests/:id', (req, res) => {
  if (String(req.query.confirm || '') !== '1') return res.status(400).json({ error: '需要 confirm=1 才删除' });
  const t = wirelessTests().find((x) => x.id === req.params.id);
  settings[TEST_KEY] = wirelessTests().filter((x) => x.id !== req.params.id);
  store.saveSettings(settings);
  if (t && t.status === 'running') {
    const d = store.getDevice(t.device);
    if (d && d.devmode) {
      publishCmd(t.device, { cmd: 'devmode', on: false });
      store.upsertDevice({ id: t.device, devmode: false, devmodeUntil: 0 });
    }
  }
  res.json({ ok: true });
});

const TUNING_KEY = 'tuningLibrary';
function tuningLibrary() {
  return Array.isArray(settings[TUNING_KEY]) ? settings[TUNING_KEY] : [];
}

app.get('/api/insights/library', (req, res) => {
  res.json({ ok: true, entries: tuningLibrary().slice(-50).reverse() });
});

/**
 * 把一条调试动作真正下发到主机（走与手动操作同一条 MQTT 通道，不是模拟）。
 * body: { action: 'diag' | 'devmode-on' | 'devmode-off' | 'reboot' | 'poweron', targets?: 'all' | [id] }
 */
app.post('/api/insights/apply', (req, res) => {
  const action = String(req.body.action || '');
  const ALLOWED = {
    diag: (id) => ({ cmd: 'diag' }),
    'devmode-on': (id) => ({ cmd: 'devmode', on: true, ttl: 1800 }),
    'devmode-off': (id) => ({ cmd: 'devmode', on: false }),
    reboot: (id) => ({ cmd: 'reboot' }),
    poweron: (id) => ({ cmd: 'poweron' }),
  };
  if (!ALLOWED[action]) return res.status(400).json({ error: '不支持的调试动作' });
  if (!mqttClient || !mqttClient.connected) return res.status(503).json({ error: '消息通道未连接，无法下发' });

  const map = store.getDevices();
  const all = Object.keys(map);
  let targets = all;
  if (Array.isArray(req.body.targets) && req.body.targets.length) {
    targets = req.body.targets.filter((id) => map[id]);
  }
  if (!targets.length) return res.status(400).json({ error: '没有可下发的主机' });

  const results = targets.map((id) => {
    const online = publishCmd(id, ALLOWED[action](id));
    store.addEvent({
      device: id, type: 'params', level: 'info',
      text: '云端调参：' + action + (online ? '（已下发，主机在线）' : '（已下发，主机离线待执行）'),
      ts: Date.now(),
    });
    return { id, online, note: online ? '已下发' : '离线，上线后执行' };
  });

  const entry = {
    at: Date.now(),
    atText: insights.fmtLocal(Date.now()),
    action,
    targets: targets.length,
    onlineTargets: results.filter((r) => r.online).length,
    by: (req.user && req.user.account) || 'admin',
  };
  settings[TUNING_KEY] = tuningLibrary().concat([entry]).slice(-200);
  store.saveSettings(settings);
  broadcast({ type: 'insights', event: 'tuning', entry });

  res.json({
    ok: true,
    action,
    applied: results.length,
    online: entry.onlineTargets,
    results,
    warn: entry.onlineTargets < results.length ? `${results.length - entry.onlineTargets} 台主机当前离线，指令已发出但要在设备上线后才执行` : null,
memo: '本次动作已写入云端调参知识库',
  });
});

app.get('/api/events', (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 2000);
  res.json({ events: store.listEvents(req.query.device || null, limit) });
});

// 开发者模式开关：{ on: true|false, ttl?: 秒 }（ttl 钳制 1~7200 秒）
app.post('/api/devices/:id/devmode', deviceParam, (req, res) => {
  const { on } = req.body;
  const ttl = Math.min(Math.max(Number(req.body.ttl) || config.devmodeDefaultTtlSec, 1), 7200);
  if (typeof on !== 'boolean') return res.status(400).json({ error: '缺少 on 字段' });
  publishCmd(req.deviceId, { cmd: 'devmode', on, ttl });
  if (on) {
    store.upsertDevice({ id: req.deviceId, devmode: true, devmodeUntil: Date.now() + ttl * 1000 });
    store.addEvent({ device: req.deviceId, type: 'devmode', level: 'info', text: `开发者模式开启（最长 ${ttl} 秒）`, ts: Date.now() });
  } else {
    store.upsertDevice({ id: req.deviceId, devmode: false, devmodeUntil: 0 });
    store.addEvent({ device: req.deviceId, type: 'devmode', level: 'info', text: '开发者模式关闭，主机恢复低功耗', ts: Date.now() });
  }
  broadcast({ type: 'devmode', device: req.deviceId, data: { on: !!on } });
  res.json({ ok: true, devmode: !!on, ttl, warn: offlineWarn(req.deviceId) });
});

// 传感器自检（逐项测试并上报结果）
app.post('/api/devices/:id/diag', deviceParam, (req, res) => {
  publishCmd(req.deviceId, { cmd: 'diag', seq: Date.now() });
  store.addEvent({ device: req.deviceId, type: 'diag', level: 'info', text: '已下发自检指令，等待主机上报', ts: Date.now() });
  res.json({ ok: true, warn: offlineWarn(req.deviceId) });
});

// 设备电源控制：关机 / 开机 / 重启（主机真实执行）
const POWER_ACTIONS = { poweroff: '关机', poweron: '开机', reboot: '重启' };
app.post('/api/devices/:id/power', deviceParam, (req, res) => {
  const action = req.body && req.body.action;
  if (!POWER_ACTIONS[action]) return res.status(400).json({ error: '无效操作（支持 poweroff 关机 / poweron 开机 / reboot 重启）' });
  publishCmd(req.deviceId, { cmd: action, seq: Date.now() });
  store.addEvent({ device: req.deviceId, type: 'power', level: 'info', text: '已下发「' + POWER_ACTIONS[action] + '」指令，等待主机执行', ts: Date.now() });
  res.json({ ok: true, action, text: POWER_ACTIONS[action], warn: offlineWarn(req.deviceId) });
});

// 远程升级固件 OTA：{ url, version, sha256? } 或 { firmwareId }
// 真 OTA 必须带 64 位 SHA256，否则固件会拒绝（与固件 otaFromUrl 一致）
app.post('/api/devices/:id/ota', deviceParam, (req, res) => {
  const body = req.body || {};
  let { url, version, sha256 } = body;
  if (body.firmwareId) {
    const fw = store.getFirmware(body.firmwareId);
    if (fw) {
      if (!version) version = fw.version;
      sha256 = fw.sha256 || sha256;
    }
  }
  if (!url && body.firmwareId && store.getFirmware(body.firmwareId)) {
    // 未显式给地址时，用后台签发的临时签名地址（30 分钟，与前端展示一致）
    const base = process.env.PUBLIC_BASE_URL || (req.protocol + '://' + req.get('host'));
    url = base + signedFwUrl(body.firmwareId, '', 30);
  }
  if (!url || !version) return res.status(400).json({ error: '缺少 url 或 version' });
  if (!/^https?:\/\/.+/i.test(String(url))) return res.status(400).json({ error: '固件下载地址必须是 http:// 或 https:// 开头' });
  if (!sha256 || !/^[0-9a-f]{64}$/i.test(String(sha256))) return res.status(400).json({ error: '缺少有效 sha256（64 位十六进制），真 OTA 必须校验固件摘要' });
  const finalSha = String(sha256).toLowerCase();
  publishCmd(req.deviceId, { cmd: 'ota', url: String(url), version: String(version).slice(0, 24), sha256: finalSha });
  // 下载 + 校验 + 重启期间固件不会发心跳，给 180 秒宽限，避免后台把「正在升级」误判成「设备离线」
  const devNow = store.getDevice(req.deviceId);
  if (devNow && devNow.online) {
    store.upsertDevice({ id: req.deviceId, otaGraceUntil: Date.now() + 180000, otaStartedAt: Date.now(), otaTargetVersion: version });
  }
  store.addEvent({ device: req.deviceId, type: 'ota', level: 'info', text: `下发 OTA：v${String(version).slice(0, 24)}（sha256=${finalSha.slice(0, 8)}…）`, ts: Date.now() });
  res.json({ ok: true, url: String(url), version: String(version).slice(0, 24), sha256: finalSha, warn: offlineWarn(req.deviceId) });
});

// 修改触发参数：{ params: {...} }（数值按范围钳制，未知字段丢弃，防止无效值写入真机）
app.post('/api/devices/:id/params', deviceParam, (req, res) => {
  const raw = (req.body && req.body.params) || {};
  const params = sanitizeDeviceParams(raw);
  if (!Object.keys(params).length) return res.status(400).json({ error: '缺少合法 params（支持：fire_detect_window/fire_sigma/leak_confirm_sec/steam_exclude_sec/remind_interval_sec/stove_timeout_sec/pet_confirm_sec/low_battery_v）' });
  publishCmd(req.deviceId, { cmd: 'set_params', params });
  store.addEvent({ device: req.deviceId, type: 'params', level: 'info', text: '已下发触发参数', ts: Date.now() });
  res.json({ ok: true, params, warn: offlineWarn(req.deviceId) });
});

// 修改播报语音内容：{ voice: {...} }
app.post('/api/devices/:id/voice', deviceParam, (req, res) => {
  const { voice } = req.body || {};
  if (!voice || typeof voice !== 'object') return res.status(400).json({ error: '缺少 voice 对象' });
  // 每条话术 ≤80 字：防超长话术撑爆固件 status 报文缓冲（JSON 截断 → 心跳被丢弃 → 误判离线）
  const trimmed = {};
  for (const k of Object.keys(voice)) {
    const s = String(voice[k] || '').trim();
    if (!s) continue;
    if (s.length > 80) return res.status(400).json({ error: `话术「${k}」超过 80 字上限（当前 ${s.length} 字）` });
    trimmed[k] = s;
  }
  if (!Object.keys(trimmed).length) return res.status(400).json({ error: '语音话术不能为空' });
  publishCmd(req.deviceId, { cmd: 'set_voice', voice: trimmed });
  store.addEvent({ device: req.deviceId, type: 'voice', level: 'info', text: '已下发语音话术', ts: Date.now() });
  res.json({ ok: true, voice: trimmed, warn: offlineWarn(req.deviceId) });
});

/* =============== AI 模型 + 检测工作流 设置中心 =============== */

// 读取全部设置（AI 配置 + 工作流 + 版本）
app.get('/api/settings', (req, res) => {
  res.json(getSettingsView());
});

// 保存 AI 模型配置：{ enabled, endpoint, apiKey, model, temperature, timeoutSec }
app.put('/api/settings/ai', (req, res) => {
  try {
    settings.ai = sanitizeAI(req.body);
    saveSettingsAndBroadcast();
    res.json({ ok: true, ai: settings.ai });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 保存检测工作流：{ workflow: [steps] }（自动校验 + 版本 +1）
app.put('/api/settings/workflow', (req, res) => {
  try {
    const wf = sanitizeWorkflow(req.body && req.body.workflow);
    settings.workflow = wf;
    settings.workflowVersion = (settings.workflowVersion || 1) + 1;
    saveSettingsAndBroadcast();
    store.addEvent({ device: '*', type: 'workflow', level: 'info', text: `工作流配置更新至 v${settings.workflowVersion}`, ts: Date.now() });
    res.json({ ok: true, workflowVersion: settings.workflowVersion });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 恢复默认工作流 / 默认 AI 配置
app.post('/api/settings/workflow/reset', (req, res) => {
  settings.workflow = JSON.parse(JSON.stringify(DEFAULT_WORKFLOW));
  settings.workflowVersion = (settings.workflowVersion || 1) + 1;
  saveSettingsAndBroadcast();
  res.json({ ok: true, workflowVersion: settings.workflowVersion });
});
app.post('/api/settings/ai/reset', (req, res) => {
  settings.ai = { ...DEFAULT_AI };
  saveSettingsAndBroadcast();
  res.json({ ok: true, ai: settings.ai });
});

// 试运行调试：用当前工作流跑一遍给定传感器快照，输出每一步判定
app.post('/api/settings/workflow/test', (req, res) => {
  try {
    const { sensors, context } = req.body || {};
    if (!sensors || typeof sensors !== 'object') return res.status(400).json({ error: '缺少 sensors 传感器快照' });
    const r = runWorkflow(sensors, context || {}, settings.workflow);
    res.json({ ok: true, workflowVersion: settings.workflowVersion, ...r });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 一键下发：把当前 AI 配置 + 工作流（含版本）下发给指定主机
app.post('/api/devices/:id/workflow', deviceParam, (req, res) => {
  publishCmd(req.deviceId, {
    cmd: 'set_workflow',
    version: settings.workflowVersion,
    workflow: settings.workflow,
    ai: { enabled: settings.ai.enabled, model: settings.ai.model, endpoint: settings.ai.endpoint, timeoutSec: settings.ai.timeoutSec }
  });
  store.addEvent({ device: req.deviceId, type: 'workflow', level: 'info', text: `已下发工作流 v${settings.workflowVersion}`, ts: Date.now() });
  res.json({ ok: true, device: req.deviceId, workflowVersion: settings.workflowVersion });
});

// 全局推送：把当前工作流 + AI 配置推送给【全部】已注册设备（整体修改）
app.post('/api/settings/workflow/push', (req, res) => {
  const payload = {
    cmd: 'set_workflow',
    version: settings.workflowVersion,
    workflow: settings.workflow,
    ai: { enabled: settings.ai.enabled, model: settings.ai.model, endpoint: settings.ai.endpoint, timeoutSec: settings.ai.timeoutSec }
  };
  const ids = Object.keys(store.getDevices());
  for (const id of ids) publishCmd(id, payload);
  store.addEvent({ device: '*', type: 'workflow', level: 'info', text: `工作流 v${settings.workflowVersion} 已推送给全部 ${ids.length} 台设备`, ts: Date.now() });
  res.json({ ok: true, pushed: ids.length, workflowVersion: settings.workflowVersion });
});

// 单设备场景判断（调试）：{ sensors, context } → 立即返回 AI/规则判定
app.post('/api/devices/:id/ai', deviceParam, async (req, res) => {
  try {
    const { sensors, context } = req.body || {};
    if (!sensors || typeof sensors !== 'object') return res.status(400).json({ error: '缺少 sensors' });
    const result = await callSceneAI(req.deviceId, sensors, context || {});
    res.json({ ok: true, device: req.deviceId, ...result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 服务健康
/* 读日志最后一行，供健康检查暴露「备份到底有没有推成功」 */
function readTailLine(file) {
  try {
    const txt = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    return txt.length ? txt[txt.length - 1].slice(0, 160) : '';
  } catch { return ''; }
}

app.get('/api/health', (req, res) => {
  // persist 用于判定「数据到底存不存得住」：云平台容器无持久盘时，重启即丢，
  // 前端据此显示告警，而不是让用户以为保存成功、过一会又变回去。
  let writable = true;
  try { fs.accessSync(config.dataDir, fs.constants.W_OK); } catch { writable = false; }
  res.json({
    ok: true,
    version: APP_VERSION,
    mqtt: mqttClient && mqttClient.connected,
    devices: Object.keys(store.getDevices()).length,
    persist: {
      gitBackup: !!process.env.GIT_DATA_REPO,
      writable,
      dataDir: config.dataDir,
      users: Object.keys(store.getUsers ? store.getUsers() : {}).length,
      // 备份是否真的在工作：有工作树、没恢复失败标记、最近一次推送是否成功
      backup: {
        workTree: fs.existsSync(path.join(config.dataDir, '.git')),
        restoreFailed: fs.existsSync(path.join(config.dataDir, '.restore_failed')),
        lastLog: readTailLine(path.join(__dirname, 'logs', 'backup.log'))
      }
    },
    uptimeSec: Math.round(process.uptime())
  });
});

/* 安装包下载：必须由后台自己给，不能经过图片 CDN ——
 * 图片 CDN 会把文件重定向成 xxx.exe~tplv-xxx-image.image，浏览器按 image 保存，双击装不上。
 * res.download 会写 Content-Disposition（含中文文件名），浏览器拿到的就是可执行的 .exe。 */
app.get('/app/xzl-kitchen-setup.exe', (req, res) => {
  res.download(path.join(__dirname, 'public', 'app', 'xzl-kitchen-setup.exe'), '小知了厨房卫士-' + APP_VERSION + '-电脑版.exe');
});
app.get('/app/xzl-kitchen.apk', (req, res) => {
  res.download(path.join(__dirname, 'public', 'app', 'xzl-kitchen.apk'), '小知了厨房卫士-' + APP_VERSION + '-安卓版.apk');
});

/* 客户端版本与升级来源：客户端 UA 里带 XZLKitchenPC/x.x.x 或 XZLKitchenApp/x.x.x，
 * 页面据此比较版本并在程序内提示升级。地址走环境变量，发版时不用改代码。 */
const APP_RELEASE = {
  windows: {
    version: process.env.APP_EXE_VERSION || APP_VERSION,
    url: process.env.APP_EXE_URL || '/app/xzl-kitchen-setup.exe',
  },
  android: {
    version: process.env.APP_APK_VERSION || APP_VERSION,
    url: process.env.APP_APK_URL || '/app/xzl-kitchen.apk',
  },
};
app.get('/api/app/version', (req, res) => {
  const platform = String(req.query.platform || '').toLowerCase();
  const one = platform === 'windows' || platform === 'android' ? { [platform]: APP_RELEASE[platform] } : APP_RELEASE;
  res.json({ ok: true, backend: APP_VERSION, release: one });
});

/* ---------------- MQTT 连接 ---------------- */
const mqttClient = mqtt.connect(config.mqtt.url, {
  clientId: config.mqtt.clientId,
  username: config.mqtt.username || undefined,
  password: config.mqtt.password || undefined,
  reconnectPeriod: 5000,
  will: config.mqtt.will || undefined
});

mqttClient.on('connect', () => {
  console.log(`[MQTT] 已连接 ${config.mqtt.url}`);
  mqttClient.subscribe(PREFIX + '+/status');
  mqttClient.subscribe(PREFIX + '+/event');
  mqttClient.subscribe(PREFIX + '+/diag');
  mqttClient.subscribe(PREFIX + '+/snap');
  mqttClient.subscribe(PREFIX + '+/ack');
  console.log(`[MQTT] 已订阅 ${PREFIX}+/status|event|diag|snap|ack`);
});

mqttClient.on('reconnect', () => console.log('[MQTT] 重连中...'));
mqttClient.on('error', (e) => console.error('[MQTT] 错误:', e.message));

mqttClient.on('message', (topic, payload) => {
  const parsed = parseTopic(topic);
  if (!parsed) return;
  // 只处理已注册设备；未知设备（未添加/已删除）忽略
  if (!isKnownDevice(parsed.device)) return;
  let msg;
  try {
    msg = JSON.parse(payload.toString());
  } catch {
    return;
  }
  if (parsed.kind === 'status') handleStatus(parsed.device, msg);
  else if (parsed.kind === 'event') handleEvent(parsed.device, msg);
  else if (parsed.kind === 'diag') handleDiag(parsed.device, msg);
  else if (parsed.kind === 'snap') handleSnap(parsed.device, msg);
  else if (parsed.kind === 'ack') handleAck(parsed.device, msg);
});

server.listen(config.httpPort, () => {
  console.log(`[HTTP] 后台网页已启动: http://localhost:${config.httpPort}`);
  console.log(`[HTTP] 健康检查:    http://localhost:${config.httpPort}/api/health`);
});
