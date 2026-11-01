/**
 * 有线调试协议 · Node 参考实现 + 自动化契约测试
 * -------------------------------------------------
 * 用途：验证「有线调试」串口协议契约可运行（与固件 esp32_backend_demo.ino
 * 的 DBG 命令集一一对应）。浏览器前端「有线调试」页的解析逻辑按本契约实现。
 *
 * 运行：node tools/dbg_protocol_test.js
 * 协议：请求 DBG:<cmd> [arg]，应答单行 JSON {"dbg","ok",...}
 */
'use strict';

/* ---- 虚拟固件状态（模拟主机 NVS 与传感器） ---- */
const state = {
  id: 'A001', fw: '1.2.0', chip: 'ESP32-C3', uptimeSec: 12345, freeHeap: 189432,
  workflowVersion: '4', workflowLoaded: true, aiEnabled: true,
  volume: 80, wifiSsid: 'MyHome-5G', wifiConnected: true,
  params: { fire_detect_window: 60, fire_sigma: 5, leak_confirm_sec: 180, steam_exclude_sec: 30,
            remind_interval_sec: 300, stove_timeout_sec: 600, pet_confirm_sec: 900, low_battery_v: 3.4 },
  voice: { gas_leak: '检测到燃气泄漏，请立即开窗通风并关闭燃气阀门', forgot_stove: '炉灶可能忘关火了，请到厨房检查',
           low_battery: '电量过低，请及时充电', test_ok: '自检通过，设备运行正常' },
  events: [], resetCount: 0, sensors: { radar: { presence: false, dist: 0 }, mq: 180, sht: { t: 26.5, h: 58 },
                                       mic: 0, light: 340, battery: 97, voltage: 4.05 }
};

function localEvent(type, level, text) {
  state.events.push({ type, level, text, ts: state.events.length });
  if (state.events.length > 20) state.events.shift();
}

/* ---- 命令处理（与固件契约一致） ---- */
function handleDbg(line) {
  if (!line.startsWith('DBG:')) return null;
  const body = line.slice(4);
  const sp = body.indexOf(' ');
  const cmd = (sp < 0 ? body : body.slice(0, sp)).trim();
  const arg = (sp < 0 ? '' : body.slice(sp + 1)).trim();
  localEvent('dbg', 'info', '收到有线调试指令: ' + cmd);
  const R = (extra = {}) => Object.assign({ dbg: cmd, ok: true }, extra);

  switch (cmd) {
    case 'ping': return R({ pong: true, ts: Date.now() });
    case 'info': return R({ id: state.id, fw: state.fw, chip: state.chip, uptimeSec: state.uptimeSec,
      freeHeap: state.freeHeap, workflowVersion: state.workflowVersion, volume: state.volume,
      wifiSsid: state.wifiSsid, params: state.params });
    case 'sensors': return R({ ts: Date.now(), sensors: state.sensors });
    case 'status': return R({ state: 'idle', devmode: false, cooking: false,
      lastEvent: state.events.length ? state.events[state.events.length - 1].text : '',
      workflow: { version: state.workflowVersion, loaded: state.workflowLoaded, aiEnabled: state.aiEnabled } });
    case 'diag': return R({ ts: Date.now(), items: [
      { name: 'radar', status: 'ok', code: null, value: '无人' },
      { name: 'mq', status: 'ok', code: null, value: state.sensors.mq },
      { name: 'sht', status: 'ok', code: null, value: '26.5C/58%' },
      { name: 'mic', status: 'ok', code: null, value: state.sensors.mic },
      { name: 'light', status: 'ok', code: null, value: state.sensors.light },
      { name: 'battery', status: 'ok', code: null, value: '97%' },
      { name: 'led', status: 'ok', code: null, value: '红→绿→蓝→灭' },
      { name: 'speaker', status: 'ok', code: null, value: '1kHz 测试音' }
    ]});
    case 'event': {
      const n = Math.min(Math.max(parseInt(arg) || 10, 1), 20);
      return R({ events: state.events.slice(-n).map(e => ({ type: e.type, level: e.level, text: e.text, ts: e.ts })) });
    }
    case 'test': {
      const target = arg;
      const vals = { radar: { value: '无人', detail: 0 }, mq: { value: 180 }, sht: { value: '26.5C/58%' },
                     mic: { value: 0 }, light: { value: 340 }, battery: { value: '97%' },
                     led: { value: '红→绿→蓝→灭' }, speaker: { value: '播放 1kHz 测试音' } };
      if (!(target in vals)) return { dbg: 'test', ok: false, target, error: '未知测试目标（可选：radar/mq/sht/mic/light/battery/led/speaker）' };
      return R(Object.assign({ target }, vals[target], { status: 'ok' }));
    }
    case 'reboot': return R({ action: 'restart', keepConfig: true });
    case 'wifi': {
      const sp2 = arg.indexOf(' ');
      const ssid = (sp2 < 0 ? arg : arg.slice(0, sp2)).trim();
      if (!ssid) return { dbg: 'wifi', ok: false, error: '用法：DBG:wifi <ssid> <pass>' };
      state.wifiSsid = ssid; state.wifiConnected = true;
      return R({ ssid, connected: true });
    }
    case 'get': {
      const key = arg;
      const map = { params: state.params, voice: state.voice,
        workflow: { version: state.workflowVersion, loaded: state.workflowLoaded, aiEnabled: state.aiEnabled },
        volume: state.volume, wifi: { ssid: state.wifiSsid, connected: state.wifiConnected } };
      if (!(key in map)) return { dbg: 'get', ok: false, key, error: '未知 key（可选：params/voice/workflow/volume/wifi）' };
      return R({ key, value: map[key] });
    }
    case 'set': {
      const sp2 = arg.indexOf(' ');
      const k = (sp2 < 0 ? arg : arg.slice(0, sp2)).trim();
      const v = (sp2 < 0 ? '{}' : arg.slice(sp2 + 1)).trim();
      let val;
      try { val = JSON.parse(v); } catch { return { dbg: 'set', ok: false, key: k, error: '参数 JSON 解析失败' }; }
      if (k === 'volume') {
        const vol = Math.max(0, Math.min(100, val.volume != null ? Number(val.volume) : Number(val) || 80));
        state.volume = vol;
        return R({ key: k, value: vol });
      }
      if (k === 'params') { Object.assign(state.params, val); return R({ key: k, value: state.params }); }
      if (k === 'voice') { Object.assign(state.voice, val); return R({ key: k, value: state.voice }); }
      if (k === 'workflow') {
        if (val.version != null) {
          state.workflowVersion = String(val.version); state.workflowLoaded = true;
          if (val.aiEnabled != null) state.aiEnabled = !!val.aiEnabled;
          return R({ key: k, value: { version: state.workflowVersion, loaded: state.workflowLoaded, aiEnabled: state.aiEnabled } });
        }
        return { dbg: 'set', ok: false, key: k, error: '需要 {"version":N}' };
      }
      return { dbg: 'set', ok: false, key: k, error: '不支持写入该 key（可选：volume/params/voice/workflow）' };
    }
    case 'reset':
      state.resetCount++;
      state.volume = 80; state.wifiSsid = ''; state.workflowVersion = ''; state.workflowLoaded = false;
      return R({ action: 'restart' });
    default:
      return { dbg: cmd, ok: false, error: '未知命令（支持 ping/info/sensors/status/diag/get/set/event/test/reboot/wifi/reset）' };
  }
}

/* ---- 契约测试（模拟浏览器 WebSerial 收发，与前端解析一致） ---- */
let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' → ' + extra : '')); }
}

function send(line) {
  return handleDbg(line); // 虚拟串口：请求行 → 应答对象（固件序列化为单行 JSON）
}

console.log('== 有线调试协议契约测试 ==');
const ping = send('DBG:ping');
t('ping 应答', ping.ok === true && ping.pong === true && ping.dbg === 'ping');

const info = send('DBG:info');
t('info 含设备详情', info.ok && info.id === 'A001' && info.fw && info.chip === 'ESP32-C3' && info.volume === 80);
t('info 含工作流/参数', info.workflowVersion === '4' && info.params.fire_detect_window === 60);

const sensors = send('DBG:sensors');
t('sensors 实时读数', sensors.ok && typeof sensors.sensors.mq === 'number' && sensors.sensors.radar && sensors.sensors.battery);

const status = send('DBG:status');
t('status 状态机', status.ok && status.workflow.loaded === true && status.workflow.aiEnabled === true);

const diag = send('DBG:diag');
t('diag 覆盖全部 8 项传感器/执行部件', diag.ok && Array.isArray(diag.items) && diag.items.length === 8 &&
  diag.items.map((i) => i.name).join(',') === 'radar,mq,sht,mic,light,battery,led,speaker' &&
  diag.items.every((i) => i.status === 'ok'));

send('DBG:ping'); send('DBG:info'); send('DBG:sensors'); // 造几条事件
const ev = send('DBG:event 5');
t('event 事件缓冲', ev.ok && Array.isArray(ev.events) && ev.events.length >= 3 && ev.events[0].text.includes('收到有线调试指令'));

const gv = send('DBG:get volume');
t('get volume', gv.ok && gv.key === 'volume' && gv.value === 80);
const gp = send('DBG:get params');
t('get params', gp.ok && gp.value.leak_confirm_sec === 180);
const gbad = send('DBG:get nope');
t('get 未知 key 拒绝', gbad.ok === false && !!gbad.error);

const setVol = send('DBG:set volume 55');
t('set volume 55', setVol.ok && setVol.value === 55 && state.volume === 55);
t('set 越界钳制', (send('DBG:set volume 150')).value === 100 && (send('DBG:set volume -3')).value === 0);
const setParam = send('DBG:set params {"remind_interval_sec":120}');
t('set params', setParam.ok && state.params.remind_interval_sec === 120);
const setVoice = send('DBG:set voice {"gas_leak":"燃气泄漏！立即通风"}');
t('set voice', setVoice.ok && state.voice.gas_leak === '燃气泄漏！立即通风');

const reset = send('DBG:reset');
t('reset 版本重置', reset.ok && reset.action === 'restart' && state.resetCount === 1 &&
  state.volume === 80 && state.workflowVersion === '');

// ---- v2.3 扩展命令 ----
const tst = send('DBG:test led');
t('test led 单项测试', tst.ok && tst.target === 'led' && tst.value.includes('红→绿→蓝→灭'));
const tstBad = send('DBG:test nope');
t('test 未知目标拒绝', tstBad.ok === false && tstBad.error.includes('未知测试目标'));
const tstRadar = send('DBG:test radar');
t('test radar 真实读数', tstRadar.ok && ('value' in tstRadar) && tstRadar.status === 'ok');

const wf = send('DBG:set workflow {"version":9,"aiEnabled":false}');
t('set workflow 版本写入', wf.ok && state.workflowVersion === '9' && state.workflowLoaded === true && state.aiEnabled === false);
const wfGet = send('DBG:get workflow');
t('get workflow 读回', wfGet.ok && wfGet.value.version === '9' && wfGet.value.aiEnabled === false);
const wfBad = send('DBG:set workflow {}');
t('set workflow 缺 version 拒绝', wfBad.ok === false);

const wfSave = send('DBG:wifi MyHome-5G secret123');
t('wifi USB 直写重连', wfSave.ok && wfSave.ssid === 'MyHome-5G' && wfSave.connected === true);
const wifiGet = send('DBG:get wifi');
t('get wifi 读回', wifiGet.ok && wifiGet.value.ssid === 'MyHome-5G' && wifiGet.value.connected === true);

const reboot = send('DBG:reboot');
t('reboot 软重启（保留配置）', reboot.ok && reboot.action === 'restart' && reboot.keepConfig === true);

const bad2 = send('DBG:hello');
t('未知命令拒绝（含新命令表）', bad2.ok === false && bad2.error.includes('test') && bad2.error.includes('reboot'));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
