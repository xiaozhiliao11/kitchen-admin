/**
 * 用户数据库 · 主机使用情况分析
 *
 * 设计原则（这条比功能重要）：
 * 只用「真实被记录下来的东西」做统计 —— 事件流（谁、什么时候、发生了什么）与设备上报时间。
 * 固件里还没接真实传感器的字段（雷达 presence / 距离 / 温湿度 / 光照 / 分贝）一律不进统计，
 * 而是在 dataCoverage 里显式标成 placeholder，页面上直接告诉用户「这几项现在没有真数据」。
 * 宁可少给一张图，也不给一张看起来漂亮、实际是常量的假图。
 */
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const TZ_OFFSET = 8 * HOUR;   // 用户所在时区固定 UTC+8，无夏令时

/** 固件当前明确为占位常量的字段（与 esp32_backend_demo.ino 的 collectSensors 对应） */
const PLACEHOLDER_FIELDS = [
  { path: 'sensors.radar.presence', label: '人体存在（雷达）', fake: '固定 false' },
  { path: 'sensors.radar.dist', label: '人体距离（雷达）', fake: '固定 0' },
  { path: 'sensors.sht.t', label: '温度', fake: '固定 26.5' },
  { path: 'sensors.sht.h', label: '湿度', fake: '固定 58.0' },
  { path: 'sensors.mq', label: '可燃气体', fake: '固定 180' },
  { path: 'sensors.mic', label: '声音强度', fake: '固定 0' },
  { path: 'sensors.light', label: '光照', fake: '固定 340' },
  { path: 'personPresent', label: '厨房是否有人', fake: '固定 false' },
  { path: 'cooking', label: '是否正在做饭', fake: '固定 false' },
  { path: 'sinceCookStartSec', label: '本次做饭已持续', fake: '固定 0' },
];

/** 能被真实统计的事件类型 */
const REAL_EVENT_TYPES = ['device', 'security', 'command', 'ack', 'diag', 'ota', 'wifi', 'voice', 'workflow', 'power', 'params', 'devmode'];

const TYPE_LABEL = {
  device: '设备在线/离线',
  security: '安全事件',
  command: '指令下发',
  ack: '设备回执',
  diag: '自检',
  ota: '固件升级',
  wifi: '网络配置',
  voice: '语音播报',
  workflow: '工作流',
  power: '开关机',
  params: '参数变更',
  devmode: '开发者模式',
};

/** store 只导出了 listEvents(device, limit)，这里统一取全部（上限 5000，与落盘上限一致） */
function allEvents(store) {
  return store.listEvents(null, 5000);
}

function startOfDay(ts) {
  const local = ts + TZ_OFFSET;
  const dayStartLocal = Math.floor(local / DAY) * DAY;
  return dayStartLocal - TZ_OFFSET;
}

function localHour(ts) {
  return Math.floor(((ts + TZ_OFFSET) % DAY) / HOUR);
}

function fmtLocal(ts) {
  if (!ts) return '—';
  const d = new Date(ts + TZ_OFFSET);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function relTime(ts, now) {
  if (!ts) return '从未上报';
  const diff = now - ts;
  if (diff < 60 * 1000) return '刚刚';
  if (diff < HOUR) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`;
  return `${Math.floor(diff / DAY)} 天前`;
}

/**
 * 生成总览。events 是最多 5000 条的滚动窗口，这一点要在返回值里告诉前端，
 * 否则「7 天趋势」看起来像全量，实际只是窗口内的数据。
 */
function buildOverview(store, days) {
  const now = Date.now();
  const span = (days || 7) * DAY;
  const since = now - span;
  const devices = store.getDevices();
  const events = allEvents(store);
  const windowEvents = events.filter((e) => (e.ts || 0) >= since);

  const since24 = now - DAY;
  const ev24 = windowEvents.filter((e) => e.ts >= since24);

  const byType = {};
  windowEvents.forEach((e) => { const t = e.type || 'other'; byType[t] = (byType[t] || 0) + 1; });

  const byHour = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0 }));
  ev24.forEach((e) => { byHour[localHour(e.ts)].count += 1; });

  const byDay = [];
  for (let i = days - 1; i >= 0; i--) {
    const d0 = startOfDay(now) - i * DAY;
    byDay.push({ date: fmtLocal(d0).slice(0, 10), ts: d0, count: 0 });
  }
  windowEvents.forEach((e) => {
    const idx = byDay.findIndex((d) => e.ts >= d.ts && e.ts < d.ts + DAY);
    if (idx >= 0) byDay[idx].count += 1;
  });

  const rows = Object.values(devices).map((d) => {
    const dev = events.filter((e) => e.device === d.id);
    const dev24 = dev.filter((e) => e.ts >= since24);
    const sec = dev.filter((e) => e.type === 'security' && e.ts >= since24);
    const lastEvent = dev.reduce((acc, e) => ((e.ts || 0) > (acc || 0) ? e.ts : acc), 0);
    // 健康度只用可解释的三项：在线状态、24h 有无上报、24h 安全事件
    let score = 100;
    if (!d.online) score -= 45;
    if (dev24.length === 0) score -= 30;
    if (sec.length > 0) score -= Math.min(25, sec.length * 5);
    if (score < 0) score = 0;
    return {
      id: d.id,
      name: (d.meta && d.meta.name) || '',
      online: !!d.online,
      lastTs: d.lastTs || 0,
      lastSeen: relTime(d.lastTs, now),
      lastSeenAt: fmtLocal(d.lastTs),
      lastEventAt: fmtLocal(lastEvent),
      fw: (d.snapshot && d.snapshot.fw) || '',
      events24h: dev24.length,
      eventsWindow: dev.length,
      security24h: sec.length,
      health: score,
      healthTag: score >= 85 ? 'good' : score >= 60 ? 'warn' : 'bad',
    };
  }).sort((a, b) => a.health - b.health);

  const online = rows.filter((r) => r.online).length;
  return {
    ok: true,
    generatedAt: now,
    windowDays: days || 7,
    windowEvents: windowEvents.length,
    eventStoreSize: events.length,
    eventStoreCapped: events.length >= 5000,
    totals: {
      devices: rows.length,
      online,
      offline: rows.length - online,
      events24h: ev24.length,
      eventsWindow: windowEvents.length,
      security24h: ev24.filter((e) => e.type === 'security').length,
      lastEventAt: fmtLocal(events.reduce((acc, e) => Math.max(acc, e.ts || 0), 0)),
    },
    byType: Object.keys(byType).sort((a, b) => byType[b] - byType[a])
      .map((t) => ({ type: t, label: TYPE_LABEL[t] || t, count: byType[t] })),
    byHour,
    byDay,
    devices: rows,
    dataCoverage: {
      real: REAL_EVENT_TYPES,
      placeholder: PLACEHOLDER_FIELDS,
      note: '统计只基于真实事件流与设备上报时间。做饭行为、离厨时长、传感器读数在固件接入真实硬件前不做统计，避免展示恒定的假值。',
    },
  };
}

/** 单台主机的使用明细：活跃时段、离线间隔（由事件间隔推断，标注 inferred） */
function buildDeviceDetail(store, id, limit) {
  const now = Date.now();
  const device = store.getDevice(id);
  if (!device) return null;
  const events = store.listEvents(id, limit || 200);
  const asc = [...events].sort((a, b) => a.ts - b.ts);

  const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0 }));
  asc.forEach((e) => { hours[localHour(e.ts)].count += 1; });

  // 离线区间：相邻两条事件间隔超过 10 分钟，视为这段时间没有上报（推断，不是直接测量）
  const gaps = [];
  for (let i = 1; i < asc.length; i++) {
    const delta = asc[i].ts - asc[i - 1].ts;
    if (delta > 10 * 60000) {
      gaps.push({
        from: fmtLocal(asc[i - 1].ts),
        to: fmtLocal(asc[i].ts),
        minutes: Math.round(delta / 60000),
        inferred: true,
      });
    }
  }

  const byType = {};
  asc.forEach((e) => { const t = e.type || 'other'; byType[t] = (byType[t] || 0) + 1; });

  return {
    ok: true,
    device: {
      id: device.id,
      name: (device.meta && device.meta.name) || '',
      note: (device.meta && device.meta.note) || '',
      online: !!device.online,
      lastTs: device.lastTs || 0,
      lastSeen: relTime(device.lastTs, now),
      createdAt: fmtLocal(device.createdAt),
      fw: (device.snapshot && device.snapshot.fw) || '',
      snapshot: device.snapshot || null,
      snapshotIsPlaceholder: true,
    },
    events: events.slice(0, 120).map((e) => ({
      ts: e.ts, at: fmtLocal(e.ts), type: e.type, label: TYPE_LABEL[e.type] || e.type,
      level: e.level || 'info', text: e.text || '',
    })),
    hours,
    byType: Object.keys(byType).map((t) => ({ type: t, label: TYPE_LABEL[t] || t, count: byType[t] })),
    gaps: gaps.slice(-30).reverse(),
    gapCount: gaps.length,
    placeholderFields: PLACEHOLDER_FIELDS,
  };
}

/**
 * 调试建议：每一条都必须能指回具体数据，且给出「为什么」。
 * 没有依据就不生成建议 —— 空的建议列表比凑数的建议有用。
 */
function buildSuggestions(store, days) {
  const now = Date.now();
  const since24 = now - DAY;
  const devices = store.getDevices();
  const events = allEvents(store).filter((e) => (e.ts || 0) >= now - (days || 7) * DAY);
  const out = [];

  const push = (s) => out.push(s);

  // 1) 安全事件：说明有人试过写主题但没签对，建议启用设备密钥
  const security = events.filter((e) => e.type === 'security');
  if (security.length > 0) {
    const devs = [...new Set(security.map((e) => e.device))].slice(0, 5).join('、');
    push({
      id: 'security-secret',
      severity: 'high',
      title: '有上报未通过验签，建议启用上行签名密钥',
      basis: `${days || 7} 天内 ${security.length} 条安全事件${devs ? '（涉及 ' + devs + '）' : ''}`,
      why: '设备如果没有配置 devSecret，后台在兼容模式下会放行但记一条安全事件。有人能往主题写消息却没签名，说明公共 broker 仍可能被冒写。',
      action: { kind: 'manual', hint: '在设备串口执行 DBG:devsecret <密钥>，并在后台设置 DEV_SECRET 后开启严格模式' },
    });
  }

  // 2) 离线频繁：在线率低的主机，先怀疑供电与 WiFi
  const offlineHeavy = Object.values(devices).filter((d) => !d.online && d.lastTs && (now - d.lastTs) > 6 * HOUR);
  if (offlineHeavy.length > 0) {
    push({
      id: 'device-offline',
      severity: 'high',
      title: `${offlineHeavy.length} 台主机超过 6 小时没上报`,
      basis: offlineHeavy.map((d) => `${d.id}（最后上报 ${fmtLocal(d.lastTs)}）`).join('；'),
      why: '持续不上报通常是断电、WiFi 掉线或设备已关机。先确认供电，再看路由器是否把 2.4G 频段关了。',
      action: { kind: 'cmd', cmd: 'diag', label: '对全部主机发起自检' },
    });
  }

  // 3) 24 小时零事件：既没上报也没指令，多半是没通电或不认识设备的主题
  const silent = Object.values(devices).filter((d) => {
    const dev24 = events.filter((e) => e.device === d.id && e.ts >= since24);
    return dev24.length === 0;
  });
  if (silent.length > 0) {
    push({
      id: 'device-silent',
      severity: 'mid',
      title: `${silent.length} 台主机 24 小时没有任何记录`,
      basis: silent.map((d) => d.id).join('、'),
      why: '完全无记录意味着既没有心跳也没有报警。若设备确实在运行，检查设备号是否与后台一致。',
      action: { kind: 'cmd', cmd: 'diag', label: '发起自检确认在线' },
    });
  }

  // 4) 固件版本不一致：多台设备版本不同会让行为差异难以复现
  const fws = {};
  Object.values(devices).forEach((d) => {
    const fw = (d.snapshot && d.snapshot.fw) || '';
    if (fw) fws[fw] = (fws[fw] || 0) + 1;
  });
  const fwList = Object.keys(fws);
  if (fwList.length > 1) {
    push({
      id: 'fw-mismatch',
      severity: 'mid',
      title: '多台主机固件版本不一致',
      basis: fwList.map((f) => `${f} × ${fws[f]} 台`).join('；'),
      why: '版本不一致时同一个问题在不同机器上表现不同，排查会互相干扰。建议统一到同一个版本。',
      action: { kind: 'link', view: 'flash', label: '去固件库统一升级' },
    });
  }

  // 5) 开发者模式开着：等于把调试口暴露在生产设备上
  const devmodeOn = Object.values(devices).filter((d) => d.snapshot && d.snapshot.devmode);
  if (devmodeOn.length > 0) {
    push({
      id: 'devmode-on',
      severity: 'mid',
      title: `${devmodeOn.length} 台主机仍处于开发者模式`,
      basis: devmodeOn.map((d) => d.id).join('、'),
      why: '开发者模式会放宽检测与播报，长时间开着一是误报多，二是调试通道常开。用完应关掉。',
      action: { kind: 'cmd', cmd: 'devmode-off', label: '关闭全部开发者模式' },
    });
  }

  // 6) 数据缺口：真实传感器没接，习惯类分析做不了
  push({
    id: 'sensor-gap',
    severity: 'info',
    title: '传感器读数尚未接入真实硬件',
    basis: '雷达 presence/距离、温湿度、气体、声音、光照在固件中均为固定常量',
    why: '这几项现在是占位值，所以「什么时候做饭、人离开多久」这类统计无从谈起。要拿到真实习惯数据，得先把 LD2410C 雷达和 SHT 温湿度接到 UART/I2C 并替换 collectSensors 的实现。',
    action: { kind: 'manual', hint: '硬件接线后修改 collectSensors，再重新烧录；后台侧无需改动，数据会自动进入分析' },
  });

  return {
    ok: true,
    generatedAt: now,
    count: out.length,
    suggestions: out,
  };
}

module.exports = { buildOverview, buildDeviceDetail, buildSuggestions, PLACEHOLDER_FIELDS, TYPE_LABEL, fmtLocal };
