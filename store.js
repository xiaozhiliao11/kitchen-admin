/**
 * 极简 JSON 文件存储（零依赖，Windows / Linux 通用）
 * 设备量与心跳频率不大时完全够用；未来数据量大可平滑迁移到 SQLite。
 *
 * devices.json : { "<device_id>": { id, meta, snapshot, lastTs, online, devmode, devmodeUntil, ... } }
 * events.json  : [ { device, type, level, text, ts, ... } ]  最多保留最近 5000 条
 */
const fs = require('fs');
const path = require('path');
const { dataDir, firmwareDir } = require('./config');

const DEV_FILE = () => path.join(dataDir, 'devices.json');
const EV_FILE = () => path.join(dataDir, 'events.json');
const SET_FILE = () => path.join(dataDir, 'settings.json');
const USER_FILE = () => path.join(dataDir, 'users.json');
const FW_DIR = () => firmwareDir;
const FW_META_FILE = () => path.join(firmwareDir, 'meta.json');

function ensureDir() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
}

function load(file, fallback) {
  ensureDir();
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function save(file, obj) {
  ensureDir();
  // 原子写盘：先写临时文件再改名，避免中途崩溃留下半截 JSON（load 兜底会丢整库）
  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, file);
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
    // 写盘失败（磁盘满/权限）不应让请求崩溃：记录并保留内存缓存，下次写入再试
    console.error('[存储] 写盘失败 ' + file + '：' + e.message);
  }
}

/* ---- 写盘节流（性能优化）：内存缓存 + 防抖落盘 ----
 * 高频心跳/事件写入时避免每次全量读写 JSON 文件，
 * 统一在 400ms 空闲窗口合并写盘（不影响功能，进程重启最多丢 400ms 内的增量）。 */
let devCache = null, devDirty = false, devTimer = null;
let evCache = null, evDirty = false, evTimer = null;
const FLUSH_MS = 400;

function getDevices() {
  if (!devCache) devCache = load(DEV_FILE(), {});
  return devCache;
}

function saveDevices(map) {
  devCache = map;
  devDirty = true;
  if (devTimer) clearTimeout(devTimer);
  devTimer = setTimeout(() => { if (devDirty) { save(DEV_FILE(), devCache); devDirty = false; } }, FLUSH_MS);
}

function getDevice(id) {
  return getDevices()[id] || null;
}

/** 合并更新单台设备记录并落盘 */
function upsertDevice(rec) {
  const map = getDevices();
  map[rec.id] = Object.assign(map[rec.id] || {}, rec);
  saveDevices(map);
  return map[rec.id];
}

/** 删除设备（设备库移除；MQTT 上报的未知设备会被忽略，不会自动重新注册） */
function removeDevice(id) {
  const map = getDevices();
  if (!map[id]) return false;
  delete map[id];
  saveDevices(map);
  return true;
}

/* ---------------- 固件库（程序烧录 / OTA） ---------------- */
/** 固件元数据列表：[{ id, name, version, note, size, uploadedAt, fileName }] */
function getFirmwares() {
  return load(FW_META_FILE(), []);
}

function saveFirmwares(list) {
  if (!fs.existsSync(firmwareDir)) fs.mkdirSync(firmwareDir, { recursive: true });
  save(FW_META_FILE(), list);
}

function getFirmware(id) {
  return getFirmwares().find((f) => f.id === id) || null;
}

function removeFirmware(id) {
  const list = getFirmwares();
  const fw = list.find((f) => f.id === id);
  if (!fw) return false;
  const file = path.join(firmwareDir, fw.fileName);
  try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch {}
  saveFirmwares(list.filter((f) => f.id !== id));
  return true;
}

function getEvents() {
  if (!evCache) evCache = load(EV_FILE(), []);
  return evCache;
}

function saveEvents(list) {
  const capped = list.slice(-5000);
  evCache = capped;
  evDirty = true;
  if (evTimer) clearTimeout(evTimer);
  evTimer = setTimeout(() => { if (evDirty) { save(EV_FILE(), evCache); evDirty = false; } }, FLUSH_MS);
  return capped;
}

function addEvent(ev) {
  const list = getEvents();
  list.push(ev);
  saveEvents(list);
  return ev;
}

/* ---- 崩溃兜底落盘 ----
 * 防抖窗口内进程退出/崩溃会丢最后 400ms 增量：退出前同步补写一次；
 * 定时兜底保证异常终止（kill -9 等）最多也只丢一个 5 秒窗口。 */
function flushDevices() { if (devDirty && devCache) { save(DEV_FILE(), devCache); devDirty = false; } }
function flushEvents() { if (evDirty && evCache) { save(EV_FILE(), evCache); evDirty = false; } }
function flushAll() { try { flushDevices(); flushEvents(); } catch (e) { console.error('[存储] 兜底落盘失败：' + e.message); } }

setInterval(() => { if (devDirty) flushDevices(); if (evDirty) flushEvents(); }, 5000);
process.on('exit', flushAll);
// 修复：注册 SIGINT/SIGTERM/SIGHUP 监听会覆盖 Node 默认的退出行为，
// 处理器内必须显式 process.exit()，否则进程收到信号只刷盘、永不退出（停机/重启会卡死）。
process.on('SIGINT', () => { flushAll(); process.exit(0); });
process.on('SIGTERM', () => { flushAll(); process.exit(0); });
process.on('SIGHUP', () => { flushAll(); process.exit(0); });

function listEvents(device, limit) {
  let list = getEvents();
  if (device) list = list.filter((e) => e.device === device);
  // 倒序：最靠近当前时间的事件排在最上面
  const sorted = [...list].sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return sorted.slice(0, limit || 100);
}

/* ---------------- 全局设置（AI 配置 / 工作流） ---------------- */

/** 读取全局设置：{ ai, workflow, workflowVersion, updatedAt } */
function getSettings(fallback) {
  return load(SET_FILE(), fallback);
}

function saveSettings(obj) {
  save(SET_FILE(), obj);
}

/* ---------------- 用户账号（多账号登录体系） ---------------- */
/* users.json : { "<account>": { account, name, role, status, salt, hash, createdAt, lastLoginAt } }
 * role: 'admin' 管理员 | 'member' 子账号
 * status: 'active' 正常 | 'paused' 已暂停（登录被拒，会话即失效）
 * 密码只存 scrypt 盐+哈希，永不存明文。 */
let userCache = null;

function getUsers() {
  if (!userCache) userCache = load(USER_FILE(), {});
  return userCache;
}

function getUser(account) {
  return getUsers()[account] || null;
}

function upsertUser(rec) {
  const m = getUsers();
  m[rec.account] = Object.assign({}, m[rec.account] || {}, rec);
  save(USER_FILE(), m);
  return m[rec.account];
}

function removeUser(account) {
  const m = getUsers();
  delete m[account];
  save(USER_FILE(), m);
}

/** 列出用户（不含密码哈希） */
function listUsers() {
  return Object.values(getUsers()).map((u) => ({
    account: u.account, name: u.name || '', role: u.role, status: u.status || 'active',
    createdAt: u.createdAt || 0, lastLoginAt: u.lastLoginAt || 0
  }));
}

module.exports = {
  getDevices,
  saveDevices,
  getDevice,
  upsertDevice,
  removeDevice,
  addEvent,
  listEvents,
  getSettings,
  saveSettings,
  getFirmwares,
  saveFirmwares,
  getFirmware,
  removeFirmware,
  getUsers,
  getUser,
  upsertUser,
  removeUser,
  listUsers
};
