/**
 * kitchen-admin 后台配置
 * 所有配置均支持环境变量覆盖，方便部署时按需调整。
 *
 * 常用环境变量：
 *   PORT                  HTTP 端口（默认 3000）
 *   MQTT_URL              MQTT Broker 地址（默认公共测试 Broker broker.emqx.io:1883）
 *   MQTT_USER / MQTT_PASS Broker 账号密码（私有 Broker 必填）
 *   MQTT_TOPIC_PREFIX     设备 topic 前缀（默认 dev/，部署私有 Broker 时建议改成自己前缀）
 *   OFFLINE_AFTER_MS      心跳超时判离线毫秒数（默认 90000 = 90 秒）
 *   DEVMODE_TTL_SEC       开发者模式默认超时秒数（默认 1800 = 30 分钟）
 *   AI_API_KEY / AI_ENDPOINT / AI_MODEL   可选：大模型 API 增强故障分析
 */
module.exports = {
  httpPort: Number(process.env.PORT || 3000),

  mqtt: {
    url: process.env.MQTT_URL || 'mqtt://broker.emqx.io:1883',
    username: process.env.MQTT_USER || '',
    password: process.env.MQTT_PASS || '',
    topicPrefix: process.env.MQTT_TOPIC_PREFIX || 'dev/',
    clientId: process.env.MQTT_CLIENT_ID || ('kitchen-admin-' + Math.random().toString(36).slice(2, 8)),
    // 设备离线由后端心跳超时判定；如需遗嘱消息，可在此发布 dev/{id}/lwt
    will: null
  },

  dataDir: process.env.DATA_DIR || './data',

  // 固件库目录（程序烧录 / OTA 固件文件）
  firmwareDir: process.env.FIRMWARE_DIR || './firmware-store',

  // 初始设备（首次启动自动注册到设备库，便于演示；页面可继续添加/删除）
  initialDevices: (process.env.INITIAL_DEVICES || 'A001,A002,A003').split(',').map((s) => s.trim()).filter(Boolean),

  // 设备心跳超过该毫秒数未上报 → 判定离线
  offlineAfterMs: Number(process.env.OFFLINE_AFTER_MS || 90000),

  // 开发者模式默认时长（秒），超时自动关闭并通知主机恢复低功耗
  devmodeDefaultTtlSec: Number(process.env.DEVMODE_TTL_SEC || 1800),

  // 可选：免费大模型 API（如硅基流动 / DeepSeek / 阿里百炼），用于故障原因的 AI 增强分析
  ai: {
    apiKey: process.env.AI_API_KEY || '',
    endpoint: process.env.AI_ENDPOINT || '',
    model: process.env.AI_MODEL || ''
  }
};
