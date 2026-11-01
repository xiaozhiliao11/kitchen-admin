/**
 * 检测工作流定义 + 校验 + 试运行规则引擎
 * -------------------------------------------------
 * 依据 V33~V46 定稿检测逻辑：
 *   P0 防忘关火 > P1 未开火燃气泄漏 > P2 双兜底；LD2410C 为核心传感器。
 *
 * 工作流 = 有序步骤（步骤可独立启停、参数可调），后台「AI 与工作流」页
 * 支持一键修改 → 保存版本 → 下发到指定/全部主机（MQTT set_workflow）。
 * 无 AI Key 时，主机与后台均可按本规则引擎执行判定（0 成本兜底）。
 */

/** 默认工作流（V46 定稿参数） */
const DEFAULT_WORKFLOW = [
  {
    id: 'scene',
    name: '场景触发判定',
    role: 'trigger',
    enabled: true,
    desc: '人体→光线→温度 依次确认，全部符合才进入燃气检测（AI 判断的核心前置链）',
    params: {
      human_first: true,      // 必须先检测到人体
      light_min: 20,          // 光线下限（0=全黑），低于下限视为夜间休眠不检测
      light_max: 3000,        // 光线上限（强光直射排除）
      temp_rise: 2.0,         // 相对基线温升 ℃，超过视为正在产生热量
      confirm_sec: 10,        // 条件保持确认时长（秒）
      require_all: true       // 必须全部满足（人体+光线+温度）
    }
  },
  {
    id: 'ignite',
    name: '点火尖峰检测',
    role: 'trigger',
    enabled: true,
    desc: '点火瞬间传感器变化率超 5σ（60s 窗口）并回落确认，最强的“正在开火”信号',
    params: {
      window_sec: 60,         // 尖峰观察窗口
      sigma: 5,               // 变化率阈值（倍标准差）
      confirm_sec: 15,        // 回落确认时长
      check_rate: true        // 用“变化速率”而非绝对值（抗误报）
    }
  },
  {
    id: 'leak',
    name: '燃气泄漏确认',
    role: 'trigger',
    enabled: true,
    desc: '仅非做饭状态：MQ 读数持续超阈值 3~5 分钟才报泄漏（做饭时 MQ 高为正常燃烧）',
    params: {
      confirm_sec: 180,       // 确认窗口（3 分钟）
      mq_threshold_adc: 3000, // MQ 分压后 ADC 读数阈值
      only_non_cooking: true  // 仅非做饭状态启用
    }
  },
  {
    id: 'steam',
    name: '蒸汽排除',
    role: 'exclude',
    enabled: true,
    desc: '湿度骤升判为蒸汽/水汽，排除泄漏误报（电水壶/高压锅场景）',
    params: {
      exclude_sec: 30,        // 湿升保持时长
      humidity_rise: 15,      // 相对基线湿度上升 %RH
      temp_rise: 3            // 伴随温升 ℃
    }
  },
  {
    id: 'stove_timeout',
    name: '防忘关火提醒（P0）',
    role: 'trigger',
    enabled: true,
    desc: '做饭态 + 人离开：5 分钟首次提醒，10 分钟二次，之后按间隔循环；产品最高优先级',
    params: {
      remind_interval_sec: 300, // 提醒间隔
      timeout_sec: 600,         // 连续无人阈值
      remind_times: 3,          // 循环提醒次数上限
      voice_level: 'high'       // 高优先级播报
    }
  },
  {
    id: 'pet',
    name: '宠物排除',
    role: 'exclude',
    enabled: true,
    desc: '15 分钟人类特征确认（体型/移动模式），宠物进厨房不触发提醒',
    params: {
      confirm_sec: 900,       // 人类特征确认窗口
      human_feature: true     // 启用人类特征识别
    }
  },
  {
    id: 'temp_fallback',
    name: '温度兜底（双兜底之一）',
    role: 'fallback',
    enabled: true,
    desc: '仅非做饭状态：温度异常持续攀升兜底告警（传感器故障时最后防线）',
    params: {
      rise_c: 5,              // 相对基线持续温升阈值
      only_non_cooking: true,
      threshold_abs: 60       // 绝对温度阈值 ℃
    }
  },
  {
    id: 'baseline',
    name: '每日基线档案',
    role: 'fallback',
    enabled: true,
    desc: '每日“未开火＋空闲”时自动建档（24h 双基线：温度+湿度），偏离预期曲线才判异常',
    params: {
      daily_profile: true,
      update_idle_only: true, // 只在未开火时更新基线
      window_hours: 24
    }
  }
];

/** 默认 AI 场景判断配置（0 成本：不填 Key 时用本地规则引擎兜底） */
const DEFAULT_AI = {
  enabled: false,        // 是否启用云端大模型场景判断
  endpoint: '',          // OpenAI 兼容接口（如 https://api.deepseek.com/v1/chat/completions）
  apiKey: '',
  model: '',
  temperature: 0.2,
  timeoutSec: 8
};

/** 步骤 id 集合 */
const STEP_IDS = DEFAULT_WORKFLOW.map((s) => s.id);

/** 数字参数的合法范围（sanitize 时钳制，防无效值下发到真机） */
const PARAM_LIMITS = {
  // scene
  light_min: [0, 4000], light_max: [0, 4000], temp_rise: [0, 20], confirm_sec: [1, 600],
  // ignite
  window_sec: [5, 600], sigma: [1, 20],
  // leak
  mq_threshold_adc: [0, 4095],
  // steam
  exclude_sec: [1, 600], humidity_rise: [0, 50],
  // stove_timeout
  remind_interval_sec: [10, 3600], timeout_sec: [10, 7200], remind_times: [1, 20],
  // pet
  // temp_fallback
  rise_c: [0, 30], threshold_abs: [20, 100],
  // baseline
  window_hours: [1, 168]
};

/** 校验工作流：必须包含全部步骤 id，且每步参数可合并覆盖（数值钳制到合法范围） */
function sanitizeWorkflow(input) {
  if (!Array.isArray(input)) throw new Error('工作流必须是步骤数组');
  const seen = new Set();
  const out = DEFAULT_WORKFLOW.map((def) => {
    const raw = input.find((s) => s && s.id === def.id);
    if (!raw) return def; // 缺省步骤用默认值
    seen.add(def.id);
    const params = {};
    for (const k of Object.keys(def.params)) {
      const defV = def.params[k];
      const rawV = raw.params ? raw.params[k] : undefined;
      if (rawV === undefined) { params[k] = defV; continue; }
      if (typeof defV === 'boolean') params[k] = !!rawV;
      else if (typeof defV === 'number') {
        const n = Number(rawV);
        const lim = PARAM_LIMITS[k];
        params[k] = Number.isFinite(n) ? (lim ? Math.min(Math.max(n, lim[0]), lim[1]) : n) : defV;
      } else params[k] = rawV;
    }
    return {
      ...def,
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : def.enabled,
      params
    };
  });
  // 多余未知步骤直接忽略（保持有序、稳定）
  return out;
}

/** 校验 AI 配置 */
function sanitizeAI(input) {
  if (!input || typeof input !== 'object') return { ...DEFAULT_AI };
  return {
    enabled: !!input.enabled,
    endpoint: String(input.endpoint || '').trim(),
    apiKey: String(input.apiKey || '').trim(),
    model: String(input.model || '').trim(),
    temperature: Number.isFinite(input.temperature) ? Math.min(Math.max(Number(input.temperature), 0), 2) : DEFAULT_AI.temperature,
    timeoutSec: Number.isFinite(input.timeoutSec) ? Math.min(Math.max(Number(input.timeoutSec), 2), 60) : DEFAULT_AI.timeoutSec
  };
}

/* ---------------- 试运行规则引擎 ---------------- */

/**
 * 逐步执行工作流。
 * @param sensors  { radar:{presence,dist}, mq:ADC, sht:{t,h}, mic, light, battery }
 * @param ctx      { personPresent, cooking, hourOfDay, cookingMinutes, sinceCookStartSec }
 * @param workflow 步骤数组（已 sanitize）
 * @returns [{step,name,result:'pass'|'fail'|'skip'|'alert',reason}, summary]
 */
function runWorkflow(sensors, ctx = {}, workflow = DEFAULT_WORKFLOW) {
  const s = sensors || {};
  const radar = s.radar || {};
  const person = typeof ctx.personPresent === 'boolean' ? ctx.personPresent : !!radar.presence;
  const cooking = !!ctx.cooking;
  const mq = Number(s.mq || 0);
  const t = Number((s.sht && s.sht.t) || 0);
  const h = Number((s.sht && s.sht.h) || 0);
  const light = Number(s.light || 0);
  const steps = [];
  const alerts = [];

  const find = (id) => (workflow || []).find((st) => st.id === id);
  const P = (id) => (find(id) || { params: {} }).params;

  // 1. 场景触发判定
  {
    const p = P('scene');
    const st = find('scene');
    if (!st || !st.enabled) {
      steps.push({ step: 'scene', name: '场景触发判定', result: 'skip', reason: '步骤已停用' });
    } else {
      const humanOk = !p.human_first || person;
      const lightOk = light >= p.light_min && light <= p.light_max;
      const tempOk = t >= 20; // 基础室温合理性
      const pass = p.require_all ? (humanOk && lightOk && tempOk) : (humanOk || lightOk);
      steps.push({
        step: 'scene', name: '场景触发判定',
        result: pass ? 'pass' : 'fail',
        reason: `人体:${person ? '在' : '不在'} 光线:${light} ${lightOk ? '√' : '×'} 温度:${t.toFixed(1)}℃ → ${pass ? '符合做饭场景' : '不符合，不进入燃气检测'}`
      });
    }
  }

  // 2. 点火尖峰检测
  {
    const p = P('ignite');
    const st = find('ignite');
    const spike = mq > 800 && mq < p.mq_threshold_adc; // 短时升高（模拟尖峰后回落）
    if (!st || !st.enabled) steps.push({ step: 'ignite', name: '点火尖峰检测', result: 'skip', reason: '步骤已停用' });
    else {
      steps.push({ step: 'ignite', name: '点火尖峰检测', result: spike ? 'pass' : 'fail', reason: spike ? '检测到点火尖峰（变化率超阈值）' : '无点火尖峰信号' });
    }
  }

  // 3. 燃气泄漏确认（仅非做饭态）
  {
    const p = P('leak');
    const st = find('leak');
    if (!st || !st.enabled) steps.push({ step: 'leak', name: '燃气泄漏确认', result: 'skip', reason: '步骤已停用' });
    else if (cooking && p.only_non_cooking) steps.push({ step: 'leak', name: '燃气泄漏确认', result: 'skip', reason: '做饭状态中（MQ 高为正常燃烧），跳过泄漏判定' });
    else {
      const leak = mq >= p.mq_threshold_adc;
      steps.push({ step: 'leak', name: '燃气泄漏确认', result: leak ? 'alert' : 'pass', reason: leak ? `MQ=${mq} 超阈值(${p.mq_threshold_adc})，持续 ${p.confirm_sec}s 将告警` : `MQ=${mq} 正常（阈值 ${p.mq_threshold_adc}）` });
      if (leak) alerts.push('GAS_LEAK');
    }
  }

  // 4. 蒸汽排除
  {
    const p = P('steam');
    const st = find('steam');
    if (!st || !st.enabled) steps.push({ step: 'steam', name: '蒸汽排除', result: 'skip', reason: '步骤已停用' });
    else {
      const steam = h >= 70 && (h - 55) >= p.humidity_rise; // 相对日常湿度上升
      steps.push({ step: 'steam', name: '蒸汽排除', result: steam ? 'pass' : 'skip', reason: steam ? `湿度 ${h.toFixed(0)}% 骤升，判定为蒸汽/水汽（排除泄漏误报）` : '湿度正常，无蒸汽干扰' });
    }
  }

  // 5. 防忘关火提醒（P0）
  {
    const p = P('stove_timeout');
    const st = find('stove_timeout');
    if (!st || !st.enabled) steps.push({ step: 'stove_timeout', name: '防忘关火提醒（P0）', result: 'skip', reason: '步骤已停用' });
    else if (!cooking) steps.push({ step: 'stove_timeout', name: '防忘关火提醒（P0）', result: 'skip', reason: '非做饭状态，无需忘关火提醒' });
    else if (person) steps.push({ step: 'stove_timeout', name: '防忘关火提醒（P0）', result: 'pass', reason: '做饭中且人在场，正常' });
    else {
      const t0 = Number(ctx.sinceCookStartSec || 0);
      const level = t0 >= p.timeout_sec ? 'alert' : (t0 >= p.remind_interval_sec ? 'warn' : 'pass');
      steps.push({ step: 'stove_timeout', name: '防忘关火提醒（P0）', result: level, reason: `做饭态 + 人离开 ${Math.round(t0 / 60)} 分钟 → ${t0 >= p.timeout_sec ? '立即告警（超时）' : t0 >= p.remind_interval_sec ? `触发提醒（${p.remind_interval_sec}s 间隔）` : '未到提醒时间'}` });
      if (level !== 'pass') alerts.push(level === 'alert' ? 'STOVE_TIMEOUT_ALERT' : 'STOVE_REMIND');
    }
  }

  // 6. 宠物排除
  {
    const p = P('pet');
    const st = find('pet');
    if (!st || !st.enabled) steps.push({ step: 'pet', name: '宠物排除', result: 'skip', reason: '步骤已停用' });
    else if (!person) steps.push({ step: 'pet', name: '宠物排除', result: 'skip', reason: '无人/无移动目标' });
    else {
      const human = radar.dist < 120; // 模拟：近距离活动视为人类特征（真实固件用 15min 确认）
      steps.push({ step: 'pet', name: '宠物排除', result: human ? 'pass' : 'skip', reason: human ? '移动目标符合人类特征（15min 确认窗口内保持）' : '疑似小体型/低速目标，等待人类特征确认' });
    }
  }

  // 7. 温度兜底
  {
    const p = P('temp_fallback');
    const st = find('temp_fallback');
    if (!st || !st.enabled) steps.push({ step: 'temp_fallback', name: '温度兜底（双兜底之一）', result: 'skip', reason: '步骤已停用' });
    else if (cooking && p.only_non_cooking) steps.push({ step: 'temp_fallback', name: '温度兜底（双兜底之一）', result: 'skip', reason: '做饭状态，温度高为正常' });
    else if (t >= p.threshold_abs) {
      steps.push({ step: 'temp_fallback', name: '温度兜底（双兜底之一）', result: 'alert', reason: `温度 ${t.toFixed(1)}℃ 超绝对阈值 ${p.threshold_abs}℃，兜底告警` });
      alerts.push('TEMP_FALLBACK');
    } else steps.push({ step: 'temp_fallback', name: '温度兜底（双兜底之一）', result: 'pass', reason: '温度正常' });
  }

  // 8. 每日基线档案（数据侧，不直接告警）
  {
    const p = P('baseline');
    const st = find('baseline');
    if (!st || !st.enabled) steps.push({ step: 'baseline', name: '每日基线档案', result: 'skip', reason: '步骤已停用' });
    else steps.push({ step: 'baseline', name: '每日基线档案', result: 'pass', reason: `未开火空闲时自动建档（${p.window_hours}h 双基线），基线更新中` });
  }

  // 汇总
  const alertsSet = [...new Set(alerts)];
  const summary = {
    alerts: alertsSet,
    level: alertsSet.includes('GAS_LEAK') || alertsSet.includes('STOVE_TIMEOUT_ALERT') ? 'high' : alertsSet.length ? 'medium' : 'low',
    next_action: alertsSet.includes('GAS_LEAK') ? '立即播报泄漏告警 + 建议通风' :
                 alertsSet.includes('STOVE_TIMEOUT_ALERT') ? '高优先级播报忘关火提醒' :
                 alertsSet.includes('STOVE_REMIND') ? '首次提醒用户检查炉灶' :
                 alertsSet.includes('TEMP_FALLBACK') ? '温度异常兜底播报' : '无告警，保持待机'
  };
  return { steps, summary };
}

module.exports = {
  DEFAULT_WORKFLOW,
  DEFAULT_AI,
  STEP_IDS,
  sanitizeWorkflow,
  sanitizeAI,
  runWorkflow
};
