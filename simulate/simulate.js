/**
 * kitchen-admin 多主机模拟器
 * 在没有真实硬件时，模拟多台「厨房AI安全提醒仪」主机按后台协议上报，
 * 用于完整演示：设备列表 / 开发者模式实时 / 传感器自检与故障分析 / OTA / 参数与语音下发。
 *
 * 运行：npm run simulate
 * 可选参数：
 *   --interval 30    心跳间隔秒数（默认 60；开发者模式时自动 5 秒）
 *   --devices A001,A002,A003   只模拟指定设备
 *   --events         允许随机产生安全事件（忘关火/泄漏演示）
 */
const mqtt = require('mqtt');
const config = require('../config');

const PREFIX = config.mqtt.topicPrefix.endsWith('/') ? config.mqtt.topicPrefix : config.mqtt.topicPrefix + '/';

// 参数解析
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const HEARTBEAT_MS = Number(opt('interval', 60)) * 1000;
const RANDOM_EVENTS = args.includes('--events');

const DEV_TEMPLATE = {
  A001: { id: 'A001', state: 'idle', battery: 97, fw: '1.2.0', fault: null },
  A002: { id: 'A002', state: 'idle', battery: 82, fw: '1.2.0', fault: 'G1' },   // 燃气传感器故障演示
  A003: { id: 'A003', state: 'low_battery', battery: 28, fw: '1.2.0', fault: 'B1' } // 低电演示
};

let deviceIds = (opt('devices', 'A001,A002,A003') || '').split(',').map((s) => s.trim()).filter(Boolean);

const client = mqtt.connect(config.mqtt.url, {
  clientId: 'kitchen-sim-' + Math.random().toString(36).slice(2, 8),
  username: config.mqtt.username || undefined,
  password: config.mqtt.password || undefined,
  reconnectPeriod: 5000
});

/** 每台模拟主机的运行状态 */
const states = {};
for (const id of deviceIds) {
  const t = DEV_TEMPLATE[id] || { id, state: 'idle', battery: 90, fw: '1.2.0', fault: null };
  states[id] = {
    ...t,
    devmode: false,
    intervalMs: HEARTBEAT_MS,
    workflowVersion: null,   // 后台下发的检测工作流版本
    workflow: null,
    ai: null,
    volume: 80,              // 播报音量 0~100（后台可下发调节，模拟“真音量变化”）
    snapTimer: null,
    params: {
      fire_detect_window: 60, fire_sigma: 5, leak_confirm_sec: 180, steam_exclude_sec: 30,
      remind_interval_sec: 300, stove_timeout_sec: 600, pet_confirm_sec: 900, low_battery_v: 3.4
    },
    voice: {
      gas_leak: '检测到燃气泄漏，请立即开窗通风并关闭燃气阀门',
      forgot_stove: '炉灶可能忘关火了，请到厨房检查',
      low_battery: '电量过低，请及时充电',
      test_ok: '自检通过，设备运行正常'
    }
  };
}

function sensorValues(s) {
  const base = {
    radar: { presence: Math.random() < 0.3, dist: 60 + Math.floor(Math.random() * 120) },
    mq: 120 + Math.floor(Math.random() * 80),
    sht: { t: 26 + Math.random() * 3, h: 55 + Math.random() * 10 },
    mic: 0,
    light: 300 + Math.floor(Math.random() * 200)
  };
  // 故障注入
  if (s.fault === 'G1') base.mq = 4095;
  return base;
}

function diagItems(s) {
  const items = [
    { name: 'radar', status: 'ok', code: null, value: sensorValues(s).radar.presence ? '有人' : '无人' },
    { name: 'mq', status: 'ok', code: null, value: sensorValues(s).mq },
    { name: 'sht', status: 'ok', code: null, value: '26.5℃/58%' },
    { name: 'mic', status: 'ok', code: null, value: 0 },
    { name: 'light', status: 'ok', code: null, value: 350 },
    { name: 'battery', status: 'ok', code: null, value: s.battery + '%' },
    { name: 'led', status: 'ok', code: null, value: '红→绿→蓝→灭' },
    { name: 'speaker', status: 'ok', code: null, value: '1kHz 测试音' }
  ];
  if (s.fault === 'G1') items[1] = { name: 'mq', status: 'err', code: 'G1', value: 4095, detail: 'ADC 满量程，疑似信号开路' };
  if (s.fault === 'B1') items[5] = { name: 'battery', status: 'warn', code: 'B1', value: s.battery + '%', detail: '电压采样低于 3.4V' };
  return items;
}

function publishStatus(id) {
  const s = states[id];
  const topic = PREFIX + id + '/status';
  client.publish(topic, JSON.stringify({
    id, ts: Date.now(),
    state: s.state,
    battery: s.battery,
    fw: s.fw,
    devmode: s.devmode,
    last_event: s.lastEvent || null,
    sensors: sensorValues(s),
    params: s.params,
    voice: s.voice,
    workflow_version: s.workflowVersion,
    wifi_ssid: s.wifi_ssid || null,
    volume: s.volume
  }), { qos: 0 });
}

function publishEvent(id, type, level, text) {
  const topic = PREFIX + id + '/event';
  client.publish(topic, JSON.stringify({ id, ts: Date.now(), type, level, text }), { qos: 1 });
  states[id].lastEvent = type;
}

/** 上传场景快照（触发后台 AI/规则场景判断） */
function publishSnap(id) {
  const s = states[id];
  const sensors = sensorValues(s);
  // 演示：A001 模拟"人+做饭迹象"，其他设备无人
  const demo = id === 'A001';
  client.publish(PREFIX + id + '/snap', JSON.stringify({
    id, ts: Date.now(), seq: Date.now(),
    sensors: { ...sensors, radar: { presence: demo, dist: demo ? 80 : 0 } },
    personPresent: demo,
    cooking: demo,
    sinceCookStartSec: demo ? 420 : 0
  }), { qos: 1 });
}

function startSnapLoop(id) {
  const s = states[id];
  if (s.snapTimer) clearInterval(s.snapTimer);
  // 收到工作流后每 15s 上传一次快照，演示后台 AI/规则场景判断
  s.snapTimer = setInterval(() => publishSnap(id), 15000);
  publishSnap(id);
}

function startDevice(id) {
  const s = states[id];
  console.log(`[模拟] ${id} 启动（${s.state}，电量${s.battery}%，固件 v${s.fw}）`);
  publishStatus(id);

  setInterval(() => {
    // 心跳
    publishStatus(id);
    // 随机安全事件（仅 --events 且 A001，低概率）
    if (RANDOM_EVENTS && id === 'A001' && Math.random() < 0.02) {
      publishEvent(id, 'forgot_stove', 'warn', '检测到炉灶疑似忘关火，已播报提醒');
    }
  }, s.intervalMs);

  // 订阅本机的下行指令与 AI 判定结果
  client.subscribe(PREFIX + id + '/cmd', (err) => {
    if (err) console.error(`[模拟] ${id} 订阅 cmd 失败:`, err.message);
  });
  client.subscribe(PREFIX + id + '/ai', (err) => {
    if (err) console.error(`[模拟] ${id} 订阅 ai 失败:`, err.message);
  });
}

client.on('connect', () => {
  console.log(`[模拟] 已连接 ${config.mqtt.url}，topic 前缀 ${PREFIX}`);
  for (const id of deviceIds) startDevice(id);
});

client.on('message', (topic, payload) => {
  // topic: dev/{id}/cmd 或 dev/{id}/ai
  if (!topic.startsWith(PREFIX)) return;
  const rest = topic.slice(PREFIX.length); // A001/cmd
  const slash = rest.lastIndexOf('/');
  if (slash <= 0) return;
  const id = rest.slice(0, slash);
  const kind = rest.slice(slash + 1);
  const s = states[id];
  if (!s) return;
  let msg; try { msg = JSON.parse(payload.toString()); } catch { return; }

  if (kind === 'ai') {
    console.log(`[模拟] ${id} 收到场景判定:`, JSON.stringify({ source: msg.source, cooking: msg.cooking, confidence: msg.confidence, reason: msg.reason }));
    return;
  }
  if (kind !== 'cmd') return;
  console.log(`[模拟] ${id} 收到指令:`, JSON.stringify(msg));

  switch (msg.cmd) {
    case 'devmode':
      s.devmode = !!msg.on;
      s.intervalMs = msg.on ? 5000 : HEARTBEAT_MS; // 开发者模式高频上报
      publishStatus(id);
      console.log(`[模拟] ${id} 开发者模式 ${msg.on ? '开启（5秒高频上报）' : '关闭（恢复低频）'}`);
      break;
    case 'diag':
      setTimeout(() => {
        const topic = PREFIX + id + '/diag';
        client.publish(topic, JSON.stringify({ id, ts: Date.now(), seq: msg.seq, result: 'done', items: diagItems(s) }), { qos: 1 });
        console.log(`[模拟] ${id} 自检完成并上报：LED 灯红→绿→蓝→灭，喇叭播放测试嘟嘟声（1kHz，真实发声）`);
      }, 800);
      break;
    case 'ota':
      console.log(`[模拟] ${id} 收到 OTA 指令 → 下载 ${msg.url}，升级到 v${msg.version}`);
      s.fw = msg.version; // 模拟升级完成
      setTimeout(() => { publishStatus(id); console.log(`[模拟] ${id} 升级完成，重启后上报 v${s.fw}`); }, 3000);
      break;
    case 'set_params':
      Object.assign(s.params, msg.params || {});
      console.log(`[模拟] ${id} 触发参数已更新:`, s.params);
      publishStatus(id);
      break;
    case 'set_voice':
      Object.assign(s.voice, msg.voice || {});
      console.log(`[模拟] ${id} 语音话术已更新:`, s.voice);
      publishStatus(id);
      break;
    case 'set_workflow':
      s.workflowVersion = msg.version;
      s.workflow = msg.workflow;
      s.ai = msg.ai || s.ai;
      console.log(`[模拟] ${id} 收到工作流 v${msg.version}（8 步）并保存，开始周期上传场景快照`);
      startSnapLoop(id);
      publishStatus(id);
      break;
    case 'set_volume':
      s.volume = Math.min(Math.max(Number(msg.volume) || 80, 0), 100);
      console.log(`[模拟] ${id} 音量已调整为 ${s.volume}%（真实播报音量将随之变化）`);
      publishStatus(id);
      break;
    case 'set_wifi':
      s.wifi_ssid = msg.ssid;
      s.wifi_pass = msg.pass || '';
      console.log(`[模拟] ${id} WiFi 配置已保存并重连 → SSID: ${msg.ssid}`);
      publishStatus(id);
      break;
    case 'poweroff':
      s.state = 'off'; s.powered = false;
      console.log(`[模拟] ${id} 收到关机指令：停止检测与播报，进入关机待机（保留监听可开机）`);
      publishStatus(id);
      break;
    case 'poweron':
      s.state = 'idle'; s.powered = true;
      console.log(`[模拟] ${id} 收到开机指令：恢复全部检测与播报`);
      publishStatus(id);
      break;
    case 'reboot':
      s.state = 'idle'; s.powered = true; s.devmode = false; s.devModeUntil = 0;
      console.log(`[模拟] ${id} 收到重启指令：软重启完成（配置保留）`);
      publishStatus(id);
      break;
    default:
      console.log(`[模拟] ${id} 未知指令:`, msg.cmd);
  }
});

client.on('error', (e) => console.error('[模拟] MQTT 错误:', e.message));
