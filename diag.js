/**
 * 传感器自检故障码 → 原因分析（规则引擎）
 * 故障码设计：前缀字母代表传感器，数字代表故障类型。
 * 规则表基于「厨房AI安全提醒仪」V46 定稿的 GPIO 与电路事实编写。
 */
const FAULT_CODES = {
  R1: {
    sensor: '雷达 LD2410C',
    reason: '雷达 UART 无响应（超时未返回人体检测数据）',
    causes: ['GPIO4(RX)/GPIO5(TX) 接线断开或虚焊', '雷达供电不足（需稳定 3.3V/5V）', '雷达 RX 端分压（6.8k/12k）异常，电平超 ESP32-C3 耐压'],
    advice: '检查雷达 4 根线（VCC/GND/OUT/TX 或 RX/TX）与分压电阻；确认供电；重新上电测试'
  },
  G1: {
    sensor: '燃气传感器 MQ',
    reason: 'MQ 的 ADC 读数满量程（约 4095），信号疑似开路',
    causes: ['MQ AO 引脚未接或虚焊', '×0.75 分压网络（R 串联）断线', '0.1µF 滤波电容漏焊', 'MQ 模块未上电'],
    advice: '检查 MQ AO → 分压电阻 → GPIO3 连线；确认 MQ 加热端供电（MT3608 5V）正常'
  },
  G2: {
    sensor: '燃气传感器 MQ',
    reason: '读数持续异常波动、无法稳定',
    causes: ['传感器预热不足（需 3~5 分钟）', 'MQ 头老化、灵敏度漂移', '升压 5V 供电抖动（MT3608 输出不稳）'],
    advice: '延长预热时间；检查 MT3608 输出稳定性；MQ 头老化则更换（约 3~6 元）'
  },
  T1: {
    sensor: '温湿度 SHT3X',
    reason: 'I2C 无应答（地址 0x44 扫描不到）',
    causes: ['SDA(GPIO6)/SCL(GPIO7) 接反或断线', '缺少 4.7k 上拉电阻', 'SHT3X 供电不足'],
    advice: '检查 I2C 两线与 4.7k 上拉；确认 VCC/GND 与模块地址 0x44'
  },
  M1: {
    sensor: '声敏传感器',
    reason: '无声音信号输出',
    causes: ['GPIO11 接线断开', '灵敏度电位器旋到最低', '传感器损坏'],
    advice: '检查 GPIO11 接线；顺时针微调灵敏度电位器后重测'
  },
  L1: {
    sensor: '光敏传感器',
    reason: '光敏读数异常（恒 0 或恒满量程）',
    causes: ['GPIO1 分压网络断线', '引脚未接或虚焊', '出光窗被遮挡'],
    advice: '检查 GPIO1 与分压电阻；确认外壳出光窗（φ10 乳白窗）未被堵'
  },
  B1: {
    sensor: '电池',
    reason: '电量过低（电压采样 < 3.4V）',
    causes: ['18650 电池亏电', '充电未完成'],
    advice: '立即充电；低电期间仅保留燃气即时检测与提醒（降功耗保护）'
  },
  B2: {
    sensor: '电池',
    reason: '电压采样异常（恒 0 或恒满量程）',
    causes: ['10k/10k 分压网络断线', 'GPIO0 未接', '低电采样引脚配置错误'],
    advice: '检查电池分压网络与 GPIO0 接线（3.7V 时应读约 1.85V）'
  },
  S1: {
    sensor: '语音功放 MAX98357A',
    reason: 'I2S 输出异常（喇叭无声）',
    causes: ['喇叭接线断', 'MAX98357A 供电不足（3.3V 峰值电流 625mA）', 'GPIO15(SD 使能) 未接对'],
    advice: '检查 GPIO12/13/14/15 与喇叭接线；确认功放供电与共地'
  }
};

/**
 * 分析一次自检结果
 * @param items [{name, status:'ok|warn|err', code, value, detail}]
 * @returns { result:'pass|fail', total, problems:[{name,code,status,reason,causes,advice}] }
 */
function analyzeDiag(items) {
  const list = items || [];
  const problems = list.filter((i) => i.status === 'err' || i.status === 'warn');
  const analyzed = problems.map((i) => {
    const rule = FAULT_CODES[i.code];
    if (rule) {
      return {
        name: i.name,
        code: i.code,
        status: i.status,
        value: i.value,
        sensor: rule.sensor,
        reason: rule.reason,
        causes: rule.causes,
        advice: rule.advice
      };
    }
    return {
      name: i.name,
      code: i.code || 'UNKNOWN',
      status: i.status,
      value: i.value,
      sensor: i.name,
      reason: i.detail || '未知故障',
      causes: ['需结合实测排查'],
      advice: '请对照 V46 设计文档 GPIO 表逐点排查'
    };
  });
  return {
    result: problems.length ? 'fail' : 'pass',
    total: list.length,
    problems: analyzed
  };
}

module.exports = { FAULT_CODES, analyzeDiag };
