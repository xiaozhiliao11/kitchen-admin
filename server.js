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
const { analyzeDiag } = require('./diag');
const { DEFAULT_WORKFLOW, DEFAULT_AI, sanitizeWorkflow, sanitizeAI, runWorkflow } = require('./workflow');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
// 前端烧录依赖：esptool-js 浏览器库（WebSerial 真烧录）+ 固件库静态目录
app.use('/vendor/esptool-js', express.static(path.join(__dirname, 'node_modules', 'esptool-js')));
app.use('/firmware-store', express.static(config.firmwareDir));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

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

function publishCmd(device, payload) {
  const dev = store.getDevice(device);
  const online = mqttClient && mqttClient.connected && dev && !!dev.online;
  mqttClient.publish(PREFIX + device + '/cmd', JSON.stringify(payload), { qos: 1 });
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

function handleStatus(device, msg) {
  const now = Date.now();
  const prev = store.getDevice(device);
  const wasOnline = prev ? !!prev.online : false;

  const rec = store.upsertDevice({
    id: device,
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
    devmode: prev && prev.devmode ? true : false,
    devmodeUntil: prev && prev.devmodeUntil ? prev.devmodeUntil : 0
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
  // 事件时间一律以服务端时间为准：真机固件上报的 ts 是运行毫秒数（millis），不是 Unix 时间戳，
  // 直接采用会导致事件时间错乱（显示 1970 年、排序异常）。
  const now = Date.now();
  const level = msg.level || 'info';
  store.addEvent({ device, type: msg.type || 'event', level, text: msg.text || '', ts: now });
  store.upsertDevice({ id: device, lastEvent: msg.type || 'event' });
  broadcast({ type: 'event', device, data: { type: msg.type, level, text: msg.text, ts: now } });
}

function handleDiag(device, msg) {
  const analysis = analyzeDiag(msg.items || []);
  // 可选 AI 增强（使用后台「AI 与工作流」页可编辑的 settings.ai；失败不影响主流程）
  const aiCfg = settings.ai;
  if (analysis.result === 'fail' && aiCfg && aiCfg.enabled && aiCfg.apiKey && aiCfg.endpoint) {
    enhanceWithAI(device, analysis).catch(() => {});
  }
  // 自检时间以服务端为准（原因同上：真机固件 ts 为运行毫秒数）
  store.upsertDevice({ id: device, lastDiag: { ts: Date.now(), seq: msg.seq, items: msg.items || [], ...analysis } });
  broadcast({ type: 'diag', device, data: { seq: msg.seq, items: msg.items || [], ...analysis } });
}

/** 心跳超时离线扫描（每 10 秒） */
setInterval(() => {
  const now = Date.now();
  const map = store.getDevices();
  let changed = false;
  for (const id of Object.keys(map)) {
    const d = map[id];
    if (d.online && now - d.lastTs > config.offlineAfterMs) {
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
  const sensors = msg.sensors || {};
  const ctx = {
    personPresent: !!((sensors.radar && sensors.radar.presence) || msg.personPresent),
    cooking: !!msg.cooking,
    sinceCookStartSec: Number(msg.sinceCookStartSec || 0)
  };
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
      lastDiag: d.lastDiag || null
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
  const rec = store.upsertDevice({
    id,
    meta: {
      name: (req.body && req.body.name || '').toString(),
      note: (req.body && req.body.note || '手动添加').toString(),
      userName: (req.body && req.body.userName || '').toString().trim(),
      userPhone: (req.body && req.body.userPhone || '').toString().trim(),
      deviceAddr: (req.body && req.body.deviceAddr || '').toString().trim()
    },
    createdAt: Date.now(),
    lastTs: 0,
    online: false
  });
  store.addEvent({ device: id, type: 'device', level: 'info', text: '设备已添加（后台注册）', ts: Date.now() });
  broadcast({ type: 'devices_sync' });
  res.json({ ok: true, device: { id, name: rec.meta.name, note: rec.meta.note, userName: rec.meta.userName, userPhone: rec.meta.userPhone, deviceAddr: rec.meta.deviceAddr, createdAt: rec.createdAt } });
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
  const fw = {
    id, name, version, note,
    size: req.body.length,
    fileName,
    uploadedAt: Date.now()
  };
  const list = store.getFirmwares();
  list.unshift(fw);
  store.saveFirmwares(list);
  res.json({ ok: true, firmware: fw, downloadUrl: '/api/firmwares/' + id + '/download' });
});

// 删除固件
app.delete('/api/firmwares/:id', (req, res) => {
  if (!store.removeFirmware(req.params.id)) return res.status(404).json({ error: '固件不存在' });
  res.json({ ok: true, deleted: req.params.id });
});

// 下载固件（同时作为 OTA 下载地址）
app.get('/api/firmwares/:id/download', (req, res) => {
  const fw = store.getFirmware(req.params.id);
  if (!fw) return res.status(404).json({ error: '固件不存在' });
  const file = path.resolve(config.firmwareDir, fw.fileName);
  if (!fs.existsSync(file)) return res.status(404).json({ error: '固件文件缺失' });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fw.fileName)}"`);
  res.sendFile(file);
});

// 事件历史（limit 钳制 1~2000，防超大请求拖慢排序）
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

// 远程升级固件 OTA：{ url, version }（url 必须为 http/https，防止向设备下发任意协议地址）
app.post('/api/devices/:id/ota', deviceParam, (req, res) => {
  const { url, version } = req.body || {};
  if (!url || !version) return res.status(400).json({ error: '缺少 url 或 version' });
  if (!/^https?:\/\/.+/i.test(String(url))) return res.status(400).json({ error: '固件下载地址必须是 http:// 或 https:// 开头' });
  publishCmd(req.deviceId, { cmd: 'ota', url: String(url), version: String(version).slice(0, 24) });
  store.addEvent({ device: req.deviceId, type: 'ota', level: 'info', text: `下发 OTA：v${String(version).slice(0, 24)}`, ts: Date.now() });
  res.json({ ok: true, url: String(url), version: String(version).slice(0, 24), warn: offlineWarn(req.deviceId) });
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
  publishCmd(req.deviceId, { cmd: 'set_voice', voice });
  store.addEvent({ device: req.deviceId, type: 'voice', level: 'info', text: '已下发语音话术', ts: Date.now() });
  res.json({ ok: true, voice, warn: offlineWarn(req.deviceId) });
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
app.get('/api/health', (req, res) => {
  res.json({ ok: true, mqtt: mqttClient && mqttClient.connected, devices: Object.keys(store.getDevices()).length });
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
  console.log(`[MQTT] 已订阅 ${PREFIX}+/status|event|diag|snap`);
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
});

server.listen(config.httpPort, () => {
  console.log(`[HTTP] 后台网页已启动: http://localhost:${config.httpPort}`);
  console.log(`[HTTP] 健康检查:    http://localhost:${config.httpPort}/api/health`);
});
