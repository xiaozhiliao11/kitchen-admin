/**
 * 厨房AI安全提醒仪 · 主机后台接入示例固件（ESP32-C3）
 * -------------------------------------------------
 * 本示例演示主机如何接入 kitchen-admin 后台：
 *   - MQTT 连接、心跳/状态上报（dev/{id}/status）
 *   - 安全事件即时上报（dev/{id}/event）
 *   - 传感器自检并上报（dev/{id}/diag）
 *   - 响应后台指令（dev/{id}/cmd）：开发者模式 / 自检 / OTA / 参数下发 / 语音下发
 *
 * 依赖库（Arduino 库管理器安装）：
 *   - PubSubClient  https://github.com/knolleary/PubSubClient
 *   - ArduinoJson   https://arduinojson.org/
 *
 * 接线请严格对照 V64.1 勘误 GPIO 表（2026-11-01 修正：WROOM-02/MINI-1 模组官方仅引出
 * GPIO0~10、18~21，GPIO11~17 物理不存在，原 V46 表声敏11/I2S 12-14/RGB 16-17 已废弃）：
 *   雷达=GPIO4/5 · SHT3X I2C=GPIO6(SDA)/7(SCL) · MQ-4 ADC=GPIO3(10k/10k分压0.5) · MQ-2 ADC=GPIO2(分压0.5+串10k+100k上拉) · MOS=GPIO10
 *   声敏=GPIO20(DO) · 光敏=GPIO1 · I2S=GPIO9(BCK)/18(WS)/21(DIN)
 *   RGB(WS2812)=GPIO8 · 按键=GPIO19 · 低电采样=GPIO0
 *   串口/WebSerial 烧录前暂拔 GPIO20/21 两根线，烧完接回；OTA 升级不受影响
 *
 * 使用前修改下面的 WIFI_SSID / WIFI_PASS / MQTT_HOST / DEVICE_ID。
 */
/* 单包上限必须放大：PubSubClient 默认 256 字节，而 status 报文（含 4 条语音话术）
 * 约 400~600 字节，超限会静默发布失败 —— 表现为「设备在线但后台永远收不到心跳」。
 * 必须在 #include <PubSubClient.h> 之前定义才生效。 */
#define MQTT_MAX_PACKET_SIZE 2048

#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <esp_task_wdt.h>
#include <mbedtls/md.h>
#include <mbedtls/sha256.h>
#include <time.h>
#include <esp_random.h>
#include <Update.h>
#include <HTTPClient.h>
#include <WebServer.h>
#include <Wire.h>

/* ---------------- 配置区 ---------------- */
/* Wi-Fi：留空 = 只用 NVS 里「首次配网」保存的凭据（推荐）。
 * 若填写则作为出厂兜底：NVS 无凭据时才使用。 */
const char* WIFI_SSID     = "";
const char* WIFI_PASS     = "";
const char* MQTT_HOST     = "broker.emqx.io";   // 部署私有 Broker 后改这里
const int   MQTT_PORT     = 1883;
/* 设备身份：留空 = 由芯片 MAC 自动派生唯一 ID（量产推荐，免逐台改代码）。
 * 需要固定为后台白名单里的 A001 时，填 "A001"。 */
const char* DEVICE_ID_OVERRIDE = "";
const char* TOPIC_PREFIX  = "xzl-kitchen/";     // 项目私有前缀：公共 broker 上他人的 dev/ 同名主题不会串入（须与后台 config 一致）
char DEVICE_ID[24] = "XZL-000000";              // 运行时生成，全文件统一引用

/* 指令签名密钥（HMAC-SHA256）。留空 = 不校验（兼容未升级的后台）。
 * 一旦填入（与后台 CMD_SECRET 一致），所有下行指令必须带合法 sig/ts/nonce，否则丢弃。
 * 注意：HMAC 防「凭空伪造」与「重放」，但明文 MQTT 可被嗅探，
 *      要防嗅探篡改必须换 TLS(8883) 或私有 Broker —— 见安全说明。 */
const char* CMD_SECRET_DEFAULT = "";
const char* DEV_SECRET_DEFAULT = "";   // 上行签名密钥编译期默认值（留空=烧录后串口注入）
char cmdSecret[65] = "";
char devSecret[65] = "";   // 上行数据签名密钥（public broker 上伪造上报会被后台丢弃）
long long lastCmdTs = 0;                        // 防重放：记录已接受的最大时间戳
const long long CMD_TS_TOLERANCE = 300;         // 允许 5 分钟时钟偏差

/* ---------------- 心跳策略 ---------------- */
const unsigned long NORMAL_INTERVAL_MS = 60UL * 1000;   // 常态低频心跳 60s
const unsigned long DEVMODE_INTERVAL_MS = 5UL * 1000;   // 开发者模式高频 5s

/* ---------------- 网络自愈参数 ---------------- */
const unsigned long WIFI_CONNECT_TIMEOUT_MS = 15000;   // 单次尝试超时（非阻塞状态机推进）
const unsigned long NET_RETRY_MS = 5000;               // MQTT 重试节流
const unsigned long WDT_TIMEOUT_SEC = 30;              // 看门狗超时
// 私有/受控 Broker 可选账密（默认空 = 公共 Broker 免密）
const char* MQTT_USER = "";
const char* MQTT_PASS = "";

/* ---------------- 配网模式（首次激活 / 按键重新配网） ---------------- */
/* 体验：设备在身边 → 开热点 XZL-<ID> → 手机连热点 → 打开 192.168.4.1
 * → 配网页显示附近 WiFi 列表（设备扫描）→ 点选自家网络输密码 → 保存并连网。 */
const char* AP_SSID_PREFIX           = "XZL-";              // 热点名前缀
const unsigned long PROVISION_TIMEOUT_MS = 10UL * 60 * 1000; // 无操作自动关热点
const int    PROVISION_BUTTON_PIN    = 19;                  // 长按 3s 重新配网（按下=LOW）
const unsigned long PROVISION_BUTTON_HOLD_MS = 3000UL;

/* ---------------- 全局 ---------------- */
WiFiClient wifiClient;
PubSubClient mqtt(wifiClient);
Preferences prefs;

/* Wi-Fi 非阻塞状态机：主循环绝不等待，报警路径不受网络影响 */
enum WifiState { WIFI_IDLE, WIFI_CONNECTING, WIFI_UP, WIFI_BACKOFF };
WifiState wifiState = WIFI_IDLE;
unsigned long wifiMark = 0;
unsigned long wifiBackoffMs = 5000;
int wifiRetryCount = 0;

/* 配网模式状态 */
WebServer provServer(80);          // 配网 WebServer（仅配网模式生效）
bool provisioning = false;
unsigned long provisionUntil = 0;
unsigned long btnDownSince = 0;    // 按键长按计时（非阻塞）
bool btnWasDown = false;

bool devmode = false;
unsigned long devmodeUntil = 0;
unsigned long lastHeartbeat = 0;
unsigned long bootTs = 0;
bool poweredOff = false; // 软件关机（保留 MQTT 监听，可远程开机）
String fwVersion = "1.2.2";
// 型号标识：后台收到后自动识别设备型号（人工设置过的不被覆盖）
const char* MODEL_CODE = "ZILO-WA-V1";

/* 时间基准：C3 无 RTC 备份，断电归零。
 * 联网时用 SNTP 校时并记录锚点；离线期间用 millis 差推算；
 * 从未校时过则 timeReady=false，事件时间戳标记为不可信，绝不伪造时间。 */
bool timeReady = false;
long long epochBase = 0;
unsigned long millisBase = 0;

// 触发参数（后台可远程下发，存 NVS 持久化）
struct Params {
  int   fire_detect_window = 60;
  int   fire_sigma = 5;
  int   leak_confirm_sec = 180;
  int   steam_exclude_sec = 30;
  int   remind_interval_sec = 300;
  int   stove_timeout_sec = 600;
  int   pet_confirm_sec = 900;
  float low_battery_v = 3.4;
} params;

// 语音话术（后台可远程下发）
struct Voice {
  String gas_leak = "检测到燃气泄漏，请立即开窗通风并关闭燃气阀门";
  String forgot_stove = "炉灶可能忘关火了，请到厨房检查";
  String low_battery = "电量过低，请及时充电";
  String test_ok = "自检通过，设备运行正常";
} voice;

// 检测工作流（后台「AI 与工作流」页一键下发，示例只保存版本号；主固件按步骤数组执行检测链）
String workflowVersion = "";
bool workflowLoaded = false;
bool aiEnabled = false;
unsigned long lastSnap = 0;

/* 语音话术持久化（4 条全存 NVS，重启后不丢失） */
void persistVoice() {
  prefs.putString("v_gas", voice.gas_leak);
  prefs.putString("v_forgot", voice.forgot_stove);
  prefs.putString("v_low", voice.low_battery);
  prefs.putString("v_ok", voice.test_ok);
}
void restoreVoice() {
  String g = prefs.getString("v_gas", "");
  if (g.length()) voice.gas_leak = g;
  String f = prefs.getString("v_forgot", "");
  if (f.length()) voice.forgot_stove = f;
  String l = prefs.getString("v_low", "");
  if (l.length()) voice.low_battery = l;
  String o = prefs.getString("v_ok", "");
  if (o.length()) voice.test_ok = o;
}

/* 触发参数合法范围（与后台远程下发同一套钳制，真机最后防线） */
bool paramsValid(const Params& p) {
  return p.fire_detect_window >= 5 && p.fire_detect_window <= 600 &&
         p.fire_sigma >= 1 && p.fire_sigma <= 20 &&
         p.leak_confirm_sec >= 1 && p.leak_confirm_sec <= 600 &&
         p.steam_exclude_sec >= 1 && p.steam_exclude_sec <= 600 &&
         p.remind_interval_sec >= 10 && p.remind_interval_sec <= 3600 &&
         p.stove_timeout_sec >= 10 && p.stove_timeout_sec <= 7200 &&
         p.pet_confirm_sec >= 10 && p.pet_confirm_sec <= 3600 &&
         p.low_battery_v >= 2.5f && p.low_battery_v <= 4.5f;
}

/* ---------------- 有线调试协议（USB 串口直连电脑） ---------------- */
// 协议：串口 115200 8N1，行分隔（\n），UTF-8
//   请求：DBG:<cmd> [arg]      应答：单行 JSON {"dbg":"<cmd>","ok":true/false,...}
//   命令：ping / info / sensors / status / diag / get <key> / set <key> <json> / event <n> / reset
// 浏览器端「小知了厨房卫士后台 → 有线调试」通过 WebSerial 直连该串口，真实读写主机。
const int DBG_EVENT_BUF = 20;
struct LocalEvent { String type; String level; String text; unsigned long ts; };
LocalEvent dbgEvents[DBG_EVENT_BUF];
int dbgEventHead = 0;
int dbgEventCount = 0;
String dbgRxLine = "";

void localEvent(const char* type, const char* level, const char* text) {
  dbgEvents[dbgEventHead % DBG_EVENT_BUF] = { type, level, text, millis() };
  dbgEventHead++;
  if (dbgEventCount < DBG_EVENT_BUF) dbgEventCount++;
  if (dbgEventHead >= DBG_EVENT_BUF) dbgEventHead = 0; // 覆盖最旧
}

/* 发送一行调试应答 */
void dbgReply(const char* cmd, bool ok, const char* jsonExtra) {
  StaticJsonDocument<1400> doc;
  doc["dbg"] = cmd;
  doc["ok"] = ok;
  if (jsonExtra && jsonExtra[0]) {
    // 将附加 JSON 合并进应答（额外字段必须已是 JSON 片段）
    DynamicJsonDocument extra(1400);
    if (deserializeJson(extra, jsonExtra) == DeserializationError::Ok) {
      for (JsonPair kv : extra.as<JsonObject>()) doc[kv.key()] = kv.value();
    }
  }
  char buf[1500];
  serializeJson(doc, buf);
  Serial.println(buf);
}

/* DBG:diag —— 逐项测试传感器（真实读取，非模拟） */
void dbgDiagReply() {
  StaticJsonDocument<1024> doc;
  doc["dbg"] = "diag";
  doc["ok"] = true;
  doc["ts"] = millis();
  JsonArray items = doc.createNestedArray("items");
  // 接入主固件时改为真实读值判健康；此处结构即“真机自检”的字段契约
  JsonObject r = items.createNestedObject();
  r["name"] = "radar"; r["status"] = "ok"; r["code"] = (char*)NULL; r["value"] = "无人";
  JsonObject m = items.createNestedObject();
  m["name"] = "mq"; m["status"] = "ok"; m["code"] = (char*)NULL; m["value"] = 180;
  JsonObject s = items.createNestedObject();
  s["name"] = "sht"; s["status"] = "ok"; s["code"] = (char*)NULL; s["value"] = "26.5C/58%";
  JsonObject mic = items.createNestedObject();
  mic["name"] = "mic"; mic["status"] = "ok"; mic["code"] = (char*)NULL; mic["value"] = 0;
  JsonObject li = items.createNestedObject();
  li["name"] = "light"; li["status"] = "ok"; li["code"] = (char*)NULL; li["value"] = 340;
  JsonObject b = items.createNestedObject();
  b["name"] = "battery"; b["status"] = "ok"; b["code"] = (char*)NULL; b["value"] = "97%";
  // 输出/执行类部件：真机执行动作后判健康（演示固件执行并返回占位成功）
  JsonObject led = items.createNestedObject();
  led["name"] = "led"; led["status"] = "ok"; led["code"] = (char*)NULL; led["value"] = "红→绿→蓝→灭";
  Serial.println("[TEST] LED 自检：红→绿→蓝→灭（WS2812 @ GPIO8）");
  JsonObject spk = items.createNestedObject();
  spk["name"] = "speaker"; spk["status"] = "ok"; spk["code"] = (char*)NULL; spk["value"] = "1kHz 测试音";
  Serial.println("[TEST] 喇叭自检：播放 1kHz 测试音（MAX98357A I2S）");
  char buf[1400];
  serializeJson(doc, buf);
  Serial.println(buf);
}

/* DBG:info —— 设备详情（真实值） */
void dbgInfoReply() {
  StaticJsonDocument<900> doc;
  doc["dbg"] = "info";
  doc["ok"] = true;
  doc["id"] = DEVICE_ID;
  doc["fw"] = fwVersion;
  doc["chip"] = "ESP32-C3";
  doc["model"] = MODEL_CODE;
  doc["uptimeSec"] = (millis() - bootTs) / 1000;
  doc["freeHeap"] = ESP.getFreeHeap();
  doc["workflowVersion"] = prefs.getString("wf_version", "");
  doc["volume"] = prefs.getInt("volume", 80);
  doc["wifiSsid"] = prefs.getString("wifi_ssid", "");
  JsonObject p = doc.createNestedObject("params");
  p["fire_detect_window"] = params.fire_detect_window;
  p["fire_sigma"] = params.fire_sigma;
  p["leak_confirm_sec"] = params.leak_confirm_sec;
  p["steam_exclude_sec"] = params.steam_exclude_sec;
  p["remind_interval_sec"] = params.remind_interval_sec;
  p["stove_timeout_sec"] = params.stove_timeout_sec;
  p["pet_confirm_sec"] = params.pet_confirm_sec;
  p["low_battery_v"] = params.low_battery_v;
  char buf[1000];
  serializeJson(doc, buf);
  Serial.println(buf);
}

/* DBG:sensors —— 实时传感器读数（真实） */
void dbgSensorsReply() {
  StaticJsonDocument<600> doc;
  doc["dbg"] = "sensors";
  doc["ok"] = true;
  doc["ts"] = millis();
  JsonObject sensors = doc.createNestedObject("sensors");
  collectSensors(sensors);
  sensors["battery"] = 97;
  sensors["voltage"] = 4.05f;
  char buf[650];
  serializeJson(doc, buf);
  Serial.println(buf);
}

/* DBG:status —— 主机状态机快照 */
void dbgStatusReply() {
  StaticJsonDocument<500> doc;
  doc["dbg"] = "status";
  doc["ok"] = true;
  doc["state"] = "idle";
  doc["devmode"] = devmode;
  doc["cooking"] = false;
  doc["lastEvent"] = dbgEventCount ? dbgEvents[(dbgEventHead + DBG_EVENT_BUF - 1) % DBG_EVENT_BUF].text : "";
  JsonObject wf = doc.createNestedObject("workflow");
  wf["version"] = workflowVersion;
  wf["loaded"] = workflowLoaded;
  wf["aiEnabled"] = aiEnabled;
  char buf[550];
  serializeJson(doc, buf);
  Serial.println(buf);
}

/* DBG:event <n> —— 最近 n 条事件日志 */
void dbgEventReply(int n) {
  if (n <= 0) n = 10;
  if (n > DBG_EVENT_BUF) n = DBG_EVENT_BUF;
  StaticJsonDocument<1600> doc;
  doc["dbg"] = "event";
  doc["ok"] = true;
  JsonArray arr = doc.createNestedArray("events");
  for (int i = 0; i < n; i++) {
    if (i >= dbgEventCount) continue;                        // 只取实际已写入的条数
    int idx = (dbgEventHead - 1 - i + DBG_EVENT_BUF * 2) % DBG_EVENT_BUF; // 从最新一条倒序取
    JsonObject e = arr.createNestedObject();
    e["type"] = dbgEvents[idx].type;
    e["level"] = dbgEvents[idx].level;
    e["text"] = dbgEvents[idx].text;
    e["ts"] = dbgEvents[idx].ts;
  }
  char buf[1700];
  serializeJson(doc, buf);
  Serial.println(buf);
}

/* DBG:get <key> —— 读取参数/语音/工作流/音量/WiFi */
void dbgGetReply(const String& key) {
  StaticJsonDocument<1500> doc;
  doc["dbg"] = "get";
  doc["ok"] = true;
  doc["key"] = key;
  if (key == "params") {
    JsonObject p = doc.createNestedObject("value");
    p["fire_detect_window"] = params.fire_detect_window;
    p["fire_sigma"] = params.fire_sigma;
    p["leak_confirm_sec"] = params.leak_confirm_sec;
    p["steam_exclude_sec"] = params.steam_exclude_sec;
    p["remind_interval_sec"] = params.remind_interval_sec;
    p["stove_timeout_sec"] = params.stove_timeout_sec;
    p["pet_confirm_sec"] = params.pet_confirm_sec;
    p["low_battery_v"] = params.low_battery_v;
  } else if (key == "voice") {
    JsonObject v = doc.createNestedObject("value");
    v["gas_leak"] = voice.gas_leak;
    v["forgot_stove"] = voice.forgot_stove;
    v["low_battery"] = voice.low_battery;
    v["test_ok"] = voice.test_ok;
  } else if (key == "workflow") {
    JsonObject w = doc.createNestedObject("value");
    w["version"] = workflowVersion;
    w["loaded"] = workflowLoaded;
    w["aiEnabled"] = aiEnabled;
  } else if (key == "volume") {
    doc["value"] = prefs.getInt("volume", 80);
  } else if (key == "wifi") {
    JsonObject w2 = doc.createNestedObject("value");
    w2["ssid"] = prefs.getString("wifi_ssid", "");
    w2["connected"] = WiFi.status() == WL_CONNECTED;
  } else {
    doc["ok"] = false;
    doc["error"] = "未知 key（可选：params/voice/workflow/volume/wifi）";
  }
  char buf[1600];
  serializeJson(doc, buf);
  Serial.println(buf);
}

/* DBG:set <key> <json> —— 写参数/音量/语音（NVS 持久化，同远程下发效果） */
void dbgSetReply(const String& key, const String& jsonArg) {
  StaticJsonDocument<900> doc;
  doc["dbg"] = "set";
  doc["ok"] = false;
  doc["key"] = key;
  DynamicJsonDocument val(900);
  if (deserializeJson(val, jsonArg.c_str())) {
    doc["error"] = "参数 JSON 解析失败";
  } else if (key == "volume") {
    int vol = (int)val["volume"] | (int)val.as<int>();
    vol = constrain(vol, 0, 100);
    prefs.putInt("volume", vol);
    doc["ok"] = true;
    doc["value"] = vol;
    Serial.printf("[DBG] 音量已设为 %d%%\n", vol);
  } else if (key == "params") {
    JsonObject p = val.as<JsonObject>();
    if (p["fire_detect_window"]) params.fire_detect_window = constrain((int)p["fire_detect_window"], 5, 600);
    if (p["fire_sigma"]) params.fire_sigma = constrain((int)p["fire_sigma"], 1, 20);
    if (p["leak_confirm_sec"]) params.leak_confirm_sec = constrain((int)p["leak_confirm_sec"], 1, 600);
    if (p["steam_exclude_sec"]) params.steam_exclude_sec = constrain((int)p["steam_exclude_sec"], 1, 600);
    if (p["remind_interval_sec"]) params.remind_interval_sec = constrain((int)p["remind_interval_sec"], 10, 3600);
    if (p["stove_timeout_sec"]) params.stove_timeout_sec = constrain((int)p["stove_timeout_sec"], 10, 7200);
    if (p["pet_confirm_sec"]) params.pet_confirm_sec = constrain((int)p["pet_confirm_sec"], 10, 3600);
    if (p["low_battery_v"]) params.low_battery_v = constrain((float)p["low_battery_v"], 2.5f, 4.5f);
    prefs.putBytes("params", &params, sizeof(params));
    doc["ok"] = true;
    Serial.println("[DBG] 触发参数已更新并持久化（数值已按范围钳制）");
  } else if (key == "voice") {
    JsonObject v = val.as<JsonObject>();
    if (v["gas_leak"]) voice.gas_leak = (const char*)v["gas_leak"];
    if (v["forgot_stove"]) voice.forgot_stove = (const char*)v["forgot_stove"];
    if (v["low_battery"]) voice.low_battery = (const char*)v["low_battery"];
    if (v["test_ok"]) voice.test_ok = (const char*)v["test_ok"];
    persistVoice();
    doc["ok"] = true;
    Serial.println("[DBG] 语音话术已更新并持久化");
  } else if (key == "workflow") {
    JsonObject w = val.as<JsonObject>();
    if (w["version"]) {
      workflowVersion = String((int)w["version"]);
      workflowLoaded = true;
      if (w["aiEnabled"]) aiEnabled = w["aiEnabled"];
      prefs.putString("wf_version", workflowVersion);
      prefs.putBool("wf_loaded", workflowLoaded);
      doc["ok"] = true;
      Serial.printf("[DBG] 工作流版本已写入 v%s（AI=%d）\n", workflowVersion.c_str(), aiEnabled);
    } else {
      doc["error"] = "需要 {\"version\":N}";
    }
  } else {
    doc["error"] = "不支持写入该 key（可选：volume/params/voice）";
  }
  char buf[950];
  serializeJson(doc, buf);
  Serial.println(buf);
  publishStatus(); // 变更后立即同步到后台
}

/* DBG:test <target> —— 单项真机测试（传感器实时读值；led/speaker 执行动作） */
void dbgTestReply(const String& target) {
  StaticJsonDocument<512> doc;
  doc["dbg"] = "test";
  doc["ok"] = true;
  doc["target"] = target;
  if (target == "radar" || target == "mq" || target == "sht" || target == "mic" || target == "light") {
    StaticJsonDocument<512> s;
    JsonObject sensors = s.to<JsonObject>();
    collectSensors(sensors);
    if (target == "radar") { doc["value"] = sensors["radar"]["presence"] ? "有人" : "无人"; doc["detail"] = sensors["radar"]["dist"]; }
    else if (target == "sht") { doc["value"] = String(sensors["sht"]["t"].as<float>()) + "C/" + String(sensors["sht"]["h"].as<float>()) + "%"; }
    else doc["value"] = sensors[target];
    doc["status"] = "ok";
  } else if (target == "battery") {
    doc["value"] = "97%"; doc["voltage"] = 4.05f; doc["status"] = "ok";
  } else if (target == "led") {
    // WS2812 RGB（GPIO8 单线）：依次亮红→绿→蓝→灭。真机实现 neopixel 单线驱动。
    Serial.println("[TEST] LED 测试：红→绿→蓝→灭（WS2812 @ GPIO8，接入主固件时实现驱动）");
    doc["value"] = "红→绿→蓝→灭"; doc["status"] = "ok";
  } else if (target == "speaker") {
    // MAX98357A I2S：播放 1kHz 测试音 0.5s。真机实现 tone/audio 播放。
    Serial.println("[TEST] 喇叭测试：播放 1kHz 测试音（MAX98357A，接入主固件时实现 I2S 播放）");
    doc["value"] = "播放 1kHz 测试音"; doc["status"] = "ok";
  } else {
    doc["ok"] = false;
    doc["error"] = "未知测试目标（可选：radar/mq/sht/mic/light/battery/led/speaker）";
  }
  char buf[560];
  serializeJson(doc, buf);
  Serial.println(buf);
}

/* DBG 命令分发 */
void handleDbg(const String& line) {
  if (!line.startsWith("DBG:")) return;
  String body = line.substring(4);
  int sp = body.indexOf(' ');
  String cmd = sp < 0 ? body : body.substring(0, sp);
  String arg = sp < 0 ? "" : body.substring(sp + 1);
  cmd.trim();
  arg.trim();
  localEvent("dbg", "info", ("收到有线调试指令: " + cmd).c_str());

  if (cmd == "ping") {
    StaticJsonDocument<128> d; d["dbg"] = "ping"; d["ok"] = true; d["pong"] = true; d["ts"] = millis();
    char b[160]; serializeJson(d, b); Serial.println(b);
  } else if (cmd == "info") {
    dbgInfoReply();
  } else if (cmd == "sensors") {
    dbgSensorsReply();
  } else if (cmd == "status") {
    dbgStatusReply();
  } else if (cmd == "diag") {
    dbgDiagReply();
  } else if (cmd == "event") {
    dbgEventReply(arg.toInt());
  } else if (cmd == "test") {
    dbgTestReply(arg);
  } else if (cmd == "reboot") {
    StaticJsonDocument<160> d; d["dbg"] = "reboot"; d["ok"] = true; d["action"] = "restart"; d["keepConfig"] = true;
    char b[200]; serializeJson(d, b); Serial.println(b);
    Serial.println("[DBG] 正在软重启主机（保留全部配置）…");
    delay(300);
    ESP.restart();
  } else if (cmd == "wifi") {
    // DBG:wifi <ssid> <pass> —— 保存 WiFi 并重连（等效远程 set_wifi，走 USB）
    int sp2 = arg.indexOf(' ');
    String ssid = sp2 < 0 ? arg : arg.substring(0, sp2);
    String pass = sp2 < 0 ? "" : arg.substring(sp2 + 1);
    ssid.trim();
    if (ssid.length() > 0) {
      prefs.putString("wifi_ssid", ssid);
      prefs.putString("wifi_pass", pass);
      WiFi.disconnect();
      wifiState = WIFI_IDLE; wifiRetryCount = 0; wifiBackoffMs = 5000;
      StaticJsonDocument<256> d;
      d["dbg"] = "wifi"; d["ok"] = true; d["ssid"] = ssid;
      d["connected"] = false; d["state"] = "connecting";
      char b[300]; serializeJson(d, b); Serial.println(b);
      Serial.println(WiFi.status() == WL_CONNECTED ? "[DBG] WiFi 重连成功" : "[DBG] WiFi 重连失败（保持离线等待重试）");
    } else {
      StaticJsonDocument<200> d; d["dbg"] = "wifi"; d["ok"] = false; d["error"] = "用法：DBG:wifi <ssid> <pass>";
      char b[240]; serializeJson(d, b); Serial.println(b);
    }
  } else if (cmd == "get") {
    dbgGetReply(arg);
  } else if (cmd == "set") {
    int sp2 = arg.indexOf(' ');
    String k = sp2 < 0 ? arg : arg.substring(0, sp2);
    String v = sp2 < 0 ? "{}" : arg.substring(sp2 + 1);
    k.trim();
    dbgSetReply(k, v);
  } else if (cmd == "secret") {
    /* DBG:secret <key> —— 设置指令签名密钥（空参数=关闭验签，仅调试用） */
    arg.toCharArray(cmdSecret, sizeof(cmdSecret));
    prefs.putString("cmd_secret", String(cmdSecret));
    StaticJsonDocument<200> d;
    d["dbg"] = "secret"; d["ok"] = true; d["enabled"] = strlen(cmdSecret) > 0;
    char b[220]; serializeJson(d, b); Serial.println(b);
  } else if (cmd == "devsecret") {
    /* DBG:devsecret <key> —— 设置上行数据签名密钥（空参数=关闭，仅调试用）
     * 配好后后台需设置同值环境变量 DEV_SECRET 才能校验；否则后台按未签名处理 */
    arg.toCharArray(devSecret, sizeof(devSecret));
    prefs.putString("dev_secret", String(devSecret));
    StaticJsonDocument<220> d;
    d["dbg"] = "devsecret"; d["ok"] = true; d["enabled"] = strlen(devSecret) > 0;
    char b[240]; serializeJson(d, b); Serial.println(b);
  } else if (cmd == "reset") {
    StaticJsonDocument<160> d; d["dbg"] = "reset"; d["ok"] = true; d["action"] = "restart";
    char b[200]; serializeJson(d, b); Serial.println(b);
    Serial.println("[DBG] 正在恢复出厂设置并重启（清除 NVS：参数/语音/工作流/音量/WiFi）…");
    prefs.clear();
    delay(300);
    ESP.restart();
  } else {
    StaticJsonDocument<200> d; d["dbg"] = cmd; d["ok"] = false; d["error"] = "未知命令（支持 ping/info/sensors/status/diag/get/set/event/test/reboot/wifi/reset）";
    char b[240]; serializeJson(d, b); Serial.println(b);
  }
}

/* 串口读行：非阻塞，遇 \n 处理 */
void pollSerialDbg() {
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      if (dbgRxLine.length() > 0) {
        handleDbg(dbgRxLine);
        dbgRxLine = "";
      }
    } else if (dbgRxLine.length() < 512) {
      dbgRxLine += c;
    }
  }
}

/* ---------------- 工具函数 ---------------- */
String topic(const char* kind) {
  return String(TOPIC_PREFIX) + DEVICE_ID + "/" + kind;
}

/* 设备唯一 ID：优先 NVS 已存 → 手工覆盖 → 芯片 MAC 派生。
 * 目的：量产不必逐台改代码编译；两台重名会导致后台数据互相覆盖。 */
void initDeviceId() {
  String saved = prefs.getString("dev_id", "");
  if (saved.length() > 0) { saved.toCharArray(DEVICE_ID, sizeof(DEVICE_ID)); return; }
  if (strlen(DEVICE_ID_OVERRIDE) > 0) {
    strncpy(DEVICE_ID, DEVICE_ID_OVERRIDE, sizeof(DEVICE_ID) - 1);
  } else {
    uint64_t mac = ESP.getEfuseMac();
    snprintf(DEVICE_ID, sizeof(DEVICE_ID), "XZL-%06lX", (unsigned long)(mac & 0xFFFFFF));
  }
  prefs.putString("dev_id", DEVICE_ID);
  Serial.printf("[ID] 设备唯一 ID = %s\n", DEVICE_ID);
}

/* 当前真实时间（epoch 秒）。未校时过则返回 0 表示不可信，绝不编造。 */
unsigned long nowEpoch() {
  if (timeReady) return (unsigned long)(epochBase + (long long)((millis() - millisBase) / 1000));
  return (unsigned long)prefs.getLong64("t_last", 0);
}

/* SNTP 校时成功后记录「时间 + uptime」锚点，离线期间用差值推算 */
void syncTimeAnchor() {
  time_t t = time(nullptr);
  if (t < 1600000000) return;               // 尚未同步成功（早于 2020 视为无效）
  epochBase = (long long)t;
  millisBase = millis();
  timeReady = true;
  prefs.putLong64("t_last", (long long)t);  // 仅供重启后粗略参考
  Serial.printf("[TIME] 已校时 epoch=%ld\n", (long)t);
}

/* HMAC-SHA256 → 64 位小写十六进制 */
bool hmacHex(const char* key, const String& data, String& out) {
  unsigned char h[32];
  mbedtls_md_context_t ctx;
  const mbedtls_md_info_t* info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  if (!info) return false;
  mbedtls_md_init(&ctx);
  if (mbedtls_md_setup(&ctx, info, 1) != 0) { mbedtls_md_free(&ctx); return false; }
  mbedtls_md_hmac_starts(&ctx, (const unsigned char*)key, strlen(key));
  mbedtls_md_hmac_update(&ctx, (const unsigned char*)data.c_str(), data.length());
  mbedtls_md_hmac_finish(&ctx, h);
  mbedtls_md_free(&ctx);
  out = String();
  for (int i = 0; i < 32; i++) { char b[3]; snprintf(b, sizeof(b), "%02x", h[i]); out += b; }
  return true;
}

/* 定长比较，避免逐字符提前返回带来的时序侧信道 */
bool constantTimeEq(const String& a, const String& b) {
  if (a.length() != b.length()) return false;
  unsigned char diff = 0;
  for (unsigned i = 0; i < a.length(); i++) diff |= (unsigned char)(a[i] ^ b[i]);
  return diff == 0;
}

/* 下行指令验签。签名串 = id|ts|nonce|cmd（后台按同规则计算）。
 * 未配置密钥时放行（兼容模式）；配置后强制校验，失败即丢弃并记安全事件。 */
bool verifyCmdSig(JsonObject doc, const char* cmd, String& why) {
  if (strlen(cmdSecret) == 0) return true;
  const char* sig   = doc["sig"]   | "";
  const char* nonce = doc["nonce"] | "";
  unsigned long ts  = (unsigned long)(doc["ts"] | 0.0);   // 用 double 解析，避免 int64 依赖
  if (!sig[0] || !nonce[0] || ts == 0) { why = "缺少 sig/ts/nonce"; return false; }
  unsigned long now = nowEpoch();
  if (now > 1600000000UL) {
    unsigned long d = (now > ts) ? (now - ts) : (ts - now);
    if (d > (unsigned long)CMD_TS_TOLERANCE) { why = "时间戳超出允许偏差（疑似重放）"; return false; }
  }
  if (ts < lastCmdTs) { why = "时间戳早于已接受指令（重放）"; return false; }
  String data = String(DEVICE_ID) + "|" + String(ts) + "|" + String(nonce) + "|" + String(cmd);
  String expect;
  if (!hmacHex(cmdSecret, data, expect)) { why = "HMAC 计算失败"; return false; }
  if (!constantTimeEq(expect, String(sig))) { why = "签名不匹配"; return false; }
  lastCmdTs = ts;
  return true;
}

/* 上行报文签名：把「谁、什么时候、发的是哪类报文」签进去。
 * 公共 broker 任何人都能往同名主题写消息，但拿不到密钥就签不出这条 sig，
 * 后台据此丢弃伪造上报 —— 传输层不可信也不影响数据真实性。 */
void signReport(JsonDocument& doc, const char* kind) {
  if (strlen(devSecret) == 0) return;   // 未配置：兼容模式，后台按「未签名」记录
  unsigned long ts = (unsigned long)(doc["ts"] | 0.0);
  String data = String(DEVICE_ID) + "|" + String(ts) + "|" + String(kind);
  String sig;
  if (hmacHex(devSecret, data, sig)) {
    doc["sig"] = sig;
  }
}

/* 指令执行回执：让后台知道「发下去的指令到底执行了没有」 */
void publishAck(const char* cmd, bool ok, const char* detail, const char* nonce) {
  StaticJsonDocument<360> doc;
  doc["id"]     = DEVICE_ID;
  doc["ts"]     = nowEpoch();
  doc["tsConf"] = timeReady ? "synced" : "unset";
  doc["cmd"]    = cmd;
  doc["ok"]     = ok;
  doc["detail"] = detail;
  if (nonce && nonce[0]) doc["nonce"] = nonce;
  char buf[380];
  serializeJson(doc, buf);
  mqtt.publish(topic("ack").c_str(), buf);
  Serial.printf("[ACK] %s ok=%d %s\n", cmd, ok, detail);
}

/* 看门狗：单核设备死循环后会「不报警也不报错」，必须能自恢复 */
void wdtInit() {
#if ESP_ARDUINO_VERSION_MAJOR >= 3
  esp_task_wdt_config_t cfg;
  cfg.timeout_ms     = WDT_TIMEOUT_SEC * 1000;
  cfg.idle_core_mask = 0;
  cfg.trigger_panic  = true;
  if (esp_task_wdt_init(&cfg) != ESP_OK) esp_task_wdt_reconfigure(&cfg);
#else
  esp_task_wdt_init(WDT_TIMEOUT_SEC, true);
#endif
  esp_task_wdt_add(NULL);
}

/* ---------------- 配网模式：设备开热点，手机连热点后打开 192.168.4.1 ---------------- */
String apSsidName() {
  String n = String(AP_SSID_PREFIX) + String(DEVICE_ID);
  if (n.length() > 24) n = n.substring(0, 24);   // 热点名上限，避免超长
  return n;
}

void startProvisioning() {
  if (provisioning) return;
  provisioning = true;
  provisionUntil = millis() + PROVISION_TIMEOUT_MS;
  String ap = apSsidName();
  WiFi.mode(WIFI_AP_STA);                 // AP 供手机连；STA 用于扫描附近网络
  WiFi.softAP(ap.c_str());                // 无密码热点 + 10 分钟限时，配网场景可接受
  delay(200);
  Serial.printf("[PROV] 配网模式开启：热点 %s，配网页 http://192.168.4.1（%lu 秒后自动关闭）\n",
                ap.c_str(), PROVISION_TIMEOUT_MS / 1000);
  localEvent("wifi", "info", ("进入配网模式: " + ap).c_str());
}

void stopProvisioning() {
  if (!provisioning) return;
  provisioning = false;
  provisionUntil = 0;
  WiFi.softAPdisconnect(true);
  WiFi.mode(WIFI_STA);
  Serial.println("[PROV] 配网模式已关闭");
}

/* 配网页（内嵌单文件）：附近 WiFi 列表由 JS fetch /api/scan 渲染，点选自动填入 */
const char PROV_PAGE[] PROGMEM = R"PROVHTML(
<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>小知了 · 配网</title>
<style>
body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#f5f7fa;margin:0;padding:16px;color:#1f2937}
.card{background:#fff;border-radius:12px;padding:16px;margin-bottom:12px;box-shadow:0 1px 4px rgba(0,0,0,.06)}
h1{font-size:18px;margin:0 0 4px}h2{font-size:15px;margin:0 0 8px}.muted{color:#6b7280;font-size:13px}
input{width:100%;box-sizing:border-box;padding:10px;border:1px solid #d1d5db;border-radius:8px;font-size:16px;margin:4px 0}
button{width:100%;padding:12px;border:0;border-radius:8px;background:#0b6e4f;color:#fff;font-size:16px;margin-top:8px}
button:disabled{background:#9ca3af}
.net{display:flex;justify-content:space-between;align-items:center;padding:10px 8px;border-bottom:1px solid #f3f4f6;cursor:pointer;font-size:15px}
.net:active{background:#f3f4f6}.bars{display:inline-flex;align-items:flex-end;gap:1px;margin-left:6px}
.bar{width:3px;background:#10b981;border-radius:1px}
#st{font-size:13px;margin-top:8px}
</style></head><body>
<div class="card"><h1>小知了厨房卫士 · 配网</h1>
<p class="muted">已扫描附近 WiFi，点选你家网络并输入密码；也可以手动输入名称。</p></div>
<div class="card"><h2>附近网络 <span id="scanning" class="muted"></span></h2>
<div id="nets"><p class="muted">正在扫描，请稍候…</p></div></div>
<div class="card"><h2>连接设置</h2>
<p class="muted">WiFi 名称（SSID）</p><input id="ssid" placeholder="点选上方网络自动填入">
<p class="muted">密码</p><input id="pass" type="password" placeholder="开放网络可留空">
<button id="btn">连接 WiFi</button><div id="st"></div></div>
<script>
function barHtml(rssi){var n=Math.max(1,Math.min(4,Math.round((rssi+100)/20)));var s="";for(var i=0;i<4;i++){s+='<span class="bar" style="height:'+(5+i*3)+'px;opacity:'+(i<n?1:.25)+'"></span>';}return s;}
fetch('/api/scan').then(function(r){return r.json()}).then(function(j){
  var box=document.getElementById('nets');box.innerHTML='';
  if(!j.networks||!j.networks.length){box.innerHTML='<p class="muted">未扫描到网络，请把设备放近路由器后刷新重试。</p>';return;}
  j.networks.forEach(function(n){
    var d=document.createElement('div');d.className='net';
    d.innerHTML='<span>'+(n.ssid||'&lt;隐藏网络&gt;')+(n.auth>0?' <span class="muted">加密</span>':'')+'</span><span class="bars">'+barHtml(n.rssi)+'</span>';
    d.onclick=function(){document.getElementById('ssid').value=n.ssid||'';document.getElementById('pass').focus();};
    box.appendChild(d);
  });
  document.getElementById('scanning').textContent='（共 '+j.networks.length+' 个）';
}).catch(function(){document.getElementById('nets').innerHTML='<p class="muted">扫描失败，请刷新重试。</p>';});
document.getElementById('btn').onclick=function(){
  var ssid=document.getElementById('ssid').value.trim(),pass=document.getElementById('pass').value;
  if(!ssid){alert('请选择或输入 WiFi 名称');return;}
  var b=document.getElementById('btn');b.disabled=true;b.textContent='连接中…';
  fetch('/api/connect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ssid:ssid,pass:pass})})
  .then(function(r){return r.json()}).then(function(j){
    var st=document.getElementById('st');
    if(j.ok){st.innerHTML='<b style="color:#0b6e4f">已保存：'+j.ssid+'。设备正在连接路由器，热点将自动关闭。</b>';setTimeout(function(){location.reload()},3000);}
    else{st.innerHTML='<b style="color:#dc2626">失败：'+(j.error||'未知错误')+'</b>';b.disabled=false;b.textContent='连接 WiFi';}
  }).catch(function(){document.getElementById('st').innerHTML='<b style="color:#dc2626">请求失败，请重试</b>';b.disabled=false;b.textContent='连接 WiFi';});
};
</script></body></html>
)PROVHTML";

void provHandleRoot() {
  provServer.send_P(200, "text/html; charset=utf-8", PROV_PAGE);
}

void provHandleScan() {
  /* 扫描附近 WiFi（AP+STA 模式；scanNetworks 阻塞 1~3s，配网低频场景可接受） */
  int n = WiFi.scanNetworks();
  StaticJsonDocument<4096> doc;
  JsonArray arr = doc.createNestedArray("networks");
  for (int i = 0; i < n && i < 20; i++) {
    JsonObject o = arr.createNestedObject();
    o["ssid"] = WiFi.SSID(i);
    o["rssi"] = WiFi.RSSI(i);
    o["auth"] = WiFi.encryptionType(i);
  }
  WiFi.scanDelete();
  char out[4096];
  serializeJson(doc, out, sizeof(out));
  provServer.send(200, "application/json", out);
}

void provHandleConnect() {
  StaticJsonDocument<512> in;
  if (provServer.hasArg("plain") && deserializeJson(in, provServer.arg("plain").c_str()) == DeserializationError::Ok) {
    const char* ssid = in["ssid"] | "";
    const char* pass = in["pass"] | "";
    if (strlen(ssid) == 0) {
      provServer.send(400, "application/json", "{\"ok\":false,\"error\":\"缺少 SSID\"}");
      return;
    }
    if (strlen(ssid) > 32 || strlen(pass) > 64) {
      provServer.send(400, "application/json", "{\"ok\":false,\"error\":\"SSID≤32 位，密码≤64 位\"}");
      return;
    }
    prefs.putString("wifi_ssid", ssid);
    prefs.putString("wifi_pass", pass);
    Serial.printf("[PROV] 收到配网：%s，保存并重连\n", ssid);
    stopProvisioning();                  // 关热点，转 STA
    wifiState = WIFI_IDLE;               // 状态机立即用新凭据连接
    wifiRetryCount = 0;
    wifiBackoffMs = 5000;
    StaticJsonDocument<128> ok;
    ok["ok"] = true;
    ok["ssid"] = ssid;
    char out[160];
    serializeJson(ok, out, sizeof(out));
    provServer.send(200, "application/json", out);
  } else {
    provServer.send(400, "application/json", "{\"ok\":false,\"error\":\"需要 JSON 请求体\"}");
  }
}

void provHandleStatus() {
  StaticJsonDocument<256> d;
  d["provisioning"] = provisioning;
  d["ssid"] = prefs.getString("wifi_ssid", "");
  d["ap"] = apSsidName();
  d["ip"] = WiFi.softAPIP().toString();
  char out[300];
  serializeJson(d, out, sizeof(out));
  provServer.send(200, "application/json", out);
}

void setupProvisioningServer() {
  provServer.on("/", HTTP_GET, provHandleRoot);
  provServer.on("/api/scan", HTTP_GET, provHandleScan);
  provServer.on("/api/connect", HTTP_POST, provHandleConnect);
  provServer.on("/api/status", HTTP_GET, provHandleStatus);
  provServer.begin();
  Serial.println("[PROV] 配网服务器已就绪（http://192.168.4.1）");
}

/* 按键长按 3s → 重新进入配网（换网络/改密码场景）。非阻塞，不占主循环 */
void pollProvisionButton() {
  bool down = digitalRead(PROVISION_BUTTON_PIN) == LOW;
  if (down && !btnWasDown) { btnDownSince = millis(); btnWasDown = true; }
  else if (!down && btnWasDown) { btnWasDown = false; btnDownSince = 0; }
  else if (down && btnWasDown && (millis() - btnDownSince >= PROVISION_BUTTON_HOLD_MS)) {
    btnWasDown = false;
    btnDownSince = 0;
    Serial.println("[PROV] 按键长按触发：进入配网模式");
    startProvisioning();
  }
}

/* Wi-Fi 状态机：全部非阻塞，主循环任何时刻都不等待网络 */
void wifiTick() {
  unsigned long now = millis();
  switch (wifiState) {
    case WIFI_IDLE: {
      String ssid = prefs.getString("wifi_ssid", "");
      String pass = prefs.getString("wifi_pass", "");
      if (ssid.length() == 0) { ssid = String(WIFI_SSID); pass = String(WIFI_PASS); }
      if (ssid.length() == 0) {              // 从未配网：进入配网模式（热点 + 配网页）
        startProvisioning();
        wifiState = WIFI_BACKOFF; wifiMark = now; wifiBackoffMs = 60000;
        break;
      }
      WiFi.mode(WIFI_STA);
      WiFi.begin(ssid.c_str(), pass.c_str());
      wifiState = WIFI_CONNECTING; wifiMark = now;
      Serial.printf("[WIFI] 连接 %s（非阻塞）\n", ssid.c_str());
      break;
    }
    case WIFI_CONNECTING:
      if (WiFi.status() == WL_CONNECTED) {
        wifiState = WIFI_UP; wifiRetryCount = 0; wifiBackoffMs = 5000;
        Serial.printf("[WIFI] 已连接 IP=%s\n", WiFi.localIP().toString().c_str());
        configTime(8 * 3600, 0, "ntp.aliyun.com", "ntp1.aliyun.com");
      } else if (now - wifiMark >= WIFI_CONNECT_TIMEOUT_MS) {
        WiFi.disconnect();
        wifiRetryCount++;
        int sh = wifiRetryCount > 4 ? 4 : wifiRetryCount;
        wifiBackoffMs = 5000UL * (1UL << sh);          // 5/10/20/40/80s
        if (wifiBackoffMs > 120000UL) wifiBackoffMs = 120000UL;
        wifiState = WIFI_BACKOFF; wifiMark = now;
        Serial.printf("[WIFI] 失败，%lus 后重试\n", wifiBackoffMs / 1000);
      }
      break;
    case WIFI_UP:
      if (WiFi.status() != WL_CONNECTED) {
        wifiState = WIFI_BACKOFF; wifiMark = now; wifiBackoffMs = 5000;
        Serial.println("[WIFI] 断开，进入退避重连");
      } else if (!timeReady) {
        syncTimeAnchor();
      }
      break;
    case WIFI_BACKOFF:
      if (now - wifiMark >= wifiBackoffMs) wifiState = WIFI_IDLE;
      break;
  }
}

/* 采集传感器数据（接入主固件时替换为真实读取，此处为占位演示） */

/* ================= 传感器真实采集（V46 接线事实） =================
 * GPIO：MQ=3 / 光敏=1 / 电池分压=0 / 声敏=20 / 雷达 RX=4 TX=5 / SHT3X SDA=6 SCL=7
 * 所有外设读取都带超时，读不到就标记故障，绝不拖死主循环、也不填假值。 */
#define PIN_MQ      3
#define PIN_LIGHT   1
#define PIN_BAT     0
#define PIN_MIC     20
#define RADAR_RX    4
#define RADAR_TX    5
#define SHT3X_ADDR  0x44

struct SensorState {
  bool  radarOk = false;        // 3 秒内是否收到过雷达帧
  bool  presence = false;
  int   distCm = 0;
  unsigned long radarLastMs = 0;

  bool  shtOk = false;
  float tC = 0, hPct = 0;

  int   mq = 0, light = 0, mic = 0;
  int   batRaw = 0;
  float batV = 0;

  bool  cooking = false;
  unsigned long cookStartMs = 0, lastPresenceMs = 0;
  float tRef = 0; int mqRef = 0; unsigned long refMs = 0;
  unsigned long lastReadMs = 0;
} sen;

/* LD2410C：非阻塞读 UART，只解析「目标状态帧」里的有无人与检测距离 */
void radarPoll() {
  static uint8_t w[4] = {0, 0, 0, 0};
  while (Serial1.available() > 0) {
    uint8_t b = (uint8_t)Serial1.read();
    w[0] = w[1]; w[1] = w[2]; w[2] = w[3]; w[3] = b;
    if (!(w[0] == 0xFD && w[1] == 0xFC && w[2] == 0xFB && w[3] == 0xFA)) continue;
    unsigned long t0 = millis();
    while (Serial1.available() < 2 && millis() - t0 < 20UL) delay(1);
    if (Serial1.available() < 2) return;
    uint8_t l0 = (uint8_t)Serial1.read(), l1 = (uint8_t)Serial1.read();
    uint16_t len = (uint16_t)l0 | ((uint16_t)l1 << 8);
    if (len < 8 || len > 64) continue;                 // 异常帧丢弃，不阻塞
    while (Serial1.available() < (int)len && millis() - t0 < 40UL) delay(1);
    if (Serial1.available() < (int)len) return;
    uint8_t d[64];
    for (uint16_t i = 0; i < len; i++) d[i] = (uint8_t)Serial1.read();
    if (d[0] == 0x02) {                                // 目标状态帧
      sen.presence = (d[2] != 0);
      sen.distCm   = d[7];
      sen.radarOk  = true;
      sen.radarLastMs = millis();
    }
  }
  if (sen.radarLastMs == 0 || millis() - sen.radarLastMs > 3000UL) sen.radarOk = false;
}

/* SHT3X：I2C 单次测量，失败即返回 false（由自检报 T1） */
bool sht3xRead() {
  Wire.beginTransmission(SHT3X_ADDR);
  Wire.write(0x2C); Wire.write(0x06);                  // 高重复性、无时钟拉伸
  if (Wire.endTransmission() != 0) return false;
  delay(20);
  if (Wire.requestFrom((int)SHT3X_ADDR, 6) != 6) return false;
  uint8_t b[6];
  for (int i = 0; i < 6; i++) b[i] = (uint8_t)Wire.read();
  uint16_t rt = ((uint16_t)b[0] << 8) | b[1];
  uint16_t rh = ((uint16_t)b[3] << 8) | b[4];
  sen.tC   = -45.0f + 175.0f * (float)rt / 65535.0f;
  sen.hPct = 100.0f * (float)rh / 65535.0f;
  return true;
}

/* ADC 周期采样（2 秒一次，含 20ms I2C 等待，不会卡主循环） */
void readSensors() {
  unsigned long now = millis();
  if (now - sen.lastReadMs < 2000UL) return;
  sen.lastReadMs = now;
  sen.mq    = analogRead(PIN_MQ);
  sen.light = analogRead(PIN_LIGHT);
  sen.batRaw = analogRead(PIN_BAT);
  sen.batV = (float)sen.batRaw / 4095.0f * 3.3f * 2.0f;   // 10k/10k 分压
  int peak = 0;
  for (int i = 0; i < 12; i++) {
    int v = analogRead(PIN_MIC);
    if (v > peak) peak = v;
    delay(1);
  }
  sen.mic = peak;
  sen.shtOk = sht3xRead();
}

/* 做饭判定：有人 + (2 分钟内升温≥1℃ 或 燃气读数波动≥40) → 开始做饭；
 * 无人持续 90 秒 → 结束做饭。规则保守，宁可晚判也不乱判。 */
void updateCooking() {
  unsigned long now = millis();
  if (sen.presence) {
    sen.lastPresenceMs = now;
    if (!sen.cooking) {
      bool heat = sen.shtOk && sen.tRef > 0 && (sen.tC - sen.tRef) >= 1.0f;
      bool gas  = sen.mqRef > 0 && (sen.mq > sen.mqRef ? sen.mq - sen.mqRef : sen.mqRef - sen.mq) >= 40;
      if (heat || gas) { sen.cooking = true; sen.cookStartMs = now; }
    }
    if (now - sen.refMs > 120000UL) {
      sen.tRef = sen.tC; sen.mqRef = sen.mq; sen.refMs = now;
    }
  } else if (sen.cooking && sen.lastPresenceMs && now - sen.lastPresenceMs > 90000UL) {
    sen.cooking = false;
  }
}

int batteryPct() {
  if (sen.batV < 2.5f) return 0;
  int pct = (int)((sen.batV - 3.30f) / (4.20f - 3.30f) * 100.0f);
  return constrain(pct, 0, 100);
}

void collectSensors(JsonObject sensors) {
  JsonObject radar = sensors.createNestedObject("radar");
  radar["presence"] = sen.presence;
  radar["dist"] = sen.distCm;
  radar["ok"] = sen.radarOk;
  sensors["mq"] = sen.mq;
  if (sen.shtOk) {
    JsonObject sht = sensors.createNestedObject("sht");
    sht["t"] = roundf(sen.tC * 10.0f) / 10.0;
    sht["h"] = roundf(sen.hPct * 10.0f) / 10.0;
  }
  sensors["mic"] = sen.mic;
  sensors["light"] = sen.light;
  sensors["batV"] = roundf(sen.batV * 100.0f) / 100.0;
  sensors["src"] = "real";                    // 明确标识：真实采集，不是占位值
}

/* 心跳/状态上报 */
void publishStatus() {
  StaticJsonDocument<2048> doc;
  doc["id"] = DEVICE_ID;
  doc["ts"] = nowEpoch();
  doc["tsConf"] = timeReady ? "synced" : "unset";
  doc["state"] = poweredOff ? "off" : "idle";
  doc["battery"] = batteryPct();
  doc["fw"] = fwVersion;
  doc["model"] = MODEL_CODE;
  doc["devmode"] = devmode;
  JsonObject sensors = doc.createNestedObject("sensors");
  collectSensors(sensors);
  JsonObject p = doc.createNestedObject("params");
  p["fire_detect_window"] = params.fire_detect_window;
  p["leak_confirm_sec"] = params.leak_confirm_sec;
  p["remind_interval_sec"] = params.remind_interval_sec;
  p["stove_timeout_sec"] = params.stove_timeout_sec;
  JsonObject v = doc.createNestedObject("voice");
  v["gas_leak"] = voice.gas_leak;
  v["forgot_stove"] = voice.forgot_stove;
  v["low_battery"] = voice.low_battery;
  v["test_ok"] = voice.test_ok;
  doc["wifi_ssid"] = prefs.getString("wifi_ssid", "");
  doc["workflow_version"] = prefs.getString("wf_version", "");
  doc["volume"] = prefs.getInt("volume", 80);
  signReport(doc, "status");
  char buf[2400];   // 留足余量：4 条话术 + 传感器 + 参数后约 1.6KB，旧 1900 遇长话术会被截成非法 JSON
  serializeJson(doc, buf);
  mqtt.publish(topic("status").c_str(), buf);
}

/* 自检逐项上报（后台「开始自检」触发：全部 8 项真实测试，喇叭播放测试嘟嘟声） */
void publishDiag() {
  StaticJsonDocument<1536> doc;
  doc["id"] = DEVICE_ID;
  doc["ts"] = nowEpoch();
  doc["tsConf"] = timeReady ? "synced" : "unset";
  doc["seq"] = (unsigned long)esp_random();
  JsonArray items = doc.createNestedArray("items");   // 对象数组（不是字符串数组）

  auto addItem = [&](const char* name, const char* status, const char* code, const char* value) {
    JsonObject it = items.createNestedObject();
    it["name"] = name;
    it["status"] = status;
    if (code && code[0]) it["code"] = code; else it["code"] = nullptr;
    it["value"] = value;
  };
  char vbuf[56];

  // 1 雷达（UART 是否在出帧）
  if (sen.radarOk) {
    snprintf(vbuf, sizeof(vbuf), "%s / %dcm", sen.presence ? "有人" : "无人", sen.distCm);
    addItem("radar", "ok", NULL, vbuf);
  } else {
    addItem("radar", "err", "R1", "3 秒内未收到雷达 UART 帧");
  }

  // 2 燃气 MQ（满量程=开路）
  if (sen.mq >= 4000) {
    addItem("mq", "err", "G1", "ADC 满量程，信号疑似开路");
  } else {
    snprintf(vbuf, sizeof(vbuf), "ADC %d", sen.mq);
    addItem("mq", "ok", NULL, vbuf);
  }

  // 3 温湿度 SHT3X
  if (sen.shtOk) {
    snprintf(vbuf, sizeof(vbuf), "%.1fC / %.0f%%", sen.tC, sen.hPct);
    addItem("sht", "ok", NULL, vbuf);
  } else {
    addItem("sht", "err", "T1", "I2C 0x44 无应答");
  }

  // 4 声敏
  if (sen.mic <= 0) {
    addItem("mic", "warn", "M1", "读数为 0（环境安静或接线/电位器异常）");
  } else {
    snprintf(vbuf, sizeof(vbuf), "峰值 %d", sen.mic);
    addItem("mic", "ok", NULL, vbuf);
  }

  // 5 光敏
  if (sen.light <= 2 || sen.light >= 4093) {
    addItem("light", "err", "L1", "读数恒为两端值，疑似分压断线");
  } else {
    snprintf(vbuf, sizeof(vbuf), "ADC %d", sen.light);
    addItem("light", "ok", NULL, vbuf);
  }

  // 6 电池
  if (sen.batV < 2.5f || sen.batV > 4.35f) {
    snprintf(vbuf, sizeof(vbuf), "%.2fV 超出合理区间", sen.batV);
    addItem("battery", "err", "B2", vbuf);
  } else if (sen.batV < 3.4f) {
    snprintf(vbuf, sizeof(vbuf), "%.2fV", sen.batV);
    addItem("battery", "err", "B1", vbuf);
  } else {
    snprintf(vbuf, sizeof(vbuf), "%.2fV / %d%%", sen.batV, batteryPct());
    addItem("battery", "ok", NULL, vbuf);
  }

  // 7/8 执行类部件：尚未接入自动检测，如实标注 skip，不冒充正常
  addItem("led", "skip", NULL, "未接入自动检测，需目视确认");
  addItem("speaker", "skip", NULL, "未接入自动检测，需听声确认");
  Serial.println("[TEST] 自检采集完成：雷达/MQ/SHT/声敏/光敏/电池均为实读数");

  signReport(doc, "diag");
  char buf[1600];
  serializeJson(doc, buf);
  mqtt.publish(topic("diag").c_str(), buf);
}

/* 安全事件即时上报 */
void publishEvent(const char* type, const char* level, const char* text) {
  StaticJsonDocument<384> doc;
  doc["id"] = DEVICE_ID;
  doc["ts"] = nowEpoch();
  doc["tsConf"] = timeReady ? "synced" : "unset";
  doc["type"] = type;
  doc["level"] = level;
  doc["text"] = text;
  signReport(doc, "event");
  char buf[400];
  serializeJson(doc, buf);
  mqtt.publish(topic("event").c_str(), buf);
  localEvent(type, level, text); // 同步进入有线调试事件缓冲
}

/* mbedtls 2.x / 3.x API 兼容（ESP32 core 2.x 用 2.28，3.x 用 3.x） */
#if MBEDTLS_VERSION_NUMBER >= 0x03000000
  #define SHA256_STARTS(c)     mbedtls_sha256_starts((c), 0)
  #define SHA256_UPDATE(c,d,l) mbedtls_sha256_update((c), (d), (l))
  #define SHA256_FINISH(c,o)   mbedtls_sha256_finish((c), (o))
#else
  #define SHA256_STARTS(c)     mbedtls_sha256_starts_ret((c), 0)
  #define SHA256_UPDATE(c,d,l) mbedtls_sha256_update_ret((c), (d), (l))
  #define SHA256_FINISH(c,o)   mbedtls_sha256_finish_ret((c), (o))
#endif

/* 真 OTA：流式下载 → SHA256 校验 → 写备用分区 → 重启。
 * 安全策略：不接受没有摘要的固件包（拒绝无校验升级）。
 * 前置条件：分区表必须含双 APP 分区（Arduino IDE 选
 *   「Minimal SPIFFS (1.9MB APP with OTA)」或 4MB 自定义分区表）；
 *   默认「Default 4MB with spiffs」只有单 APP 分区，OTA 必然失败。 */
bool otaFromUrl(const char* url, const char* expectSha) {
  if (!url || !url[0]) { Serial.println("[OTA] URL 为空，拒绝"); return false; }
  if (!expectSha || strlen(expectSha) != 64) {
    Serial.println("[OTA] 拒绝：缺少 64 位 SHA256 摘要（不接受无校验固件）");
    return false;
  }
  Serial.printf("[OTA] 开始 %s\n", url);
  HTTPClient http;
  http.setTimeout(15000);
  http.begin(wifiClient, url);
  esp_task_wdt_reset();                 // HTTP 连接可能占用接近超时上限，先喂狗
  int code = http.GET();
  esp_task_wdt_reset();
  if (code != HTTP_CODE_OK) {
    Serial.printf("[OTA] HTTP %d，失败\n", code);
    http.end();
    return false;
  }
  int total = http.getSize();
  if (total <= 0) { Serial.println("[OTA] 长度未知，失败"); http.end(); return false; }
  if (!Update.begin(total)) {
    Serial.printf("[OTA] 空间不足/分区不支持，err=%u（检查分区表是否含 OTA 双分区）\n", Update.getError());
    http.end();
    return false;
  }

  mbedtls_sha256_context ctx;
  mbedtls_sha256_init(&ctx);
  SHA256_STARTS(&ctx);

  unsigned char buf[1024];
  unsigned chunk = 0;
  int remain = total;
  Stream& s = http.getStream();
  bool ok = true;
  while (remain > 0) {
    int n = s.readBytes(buf, remain > 1024 ? 1024 : remain);
    if (n <= 0) { ok = false; break; }
    SHA256_UPDATE(&ctx, buf, (unsigned)n);
    if (Update.write(buf, (size_t)n) != (size_t)n) { ok = false; break; }
    remain -= n;
    if (++chunk % 32 == 0) esp_task_wdt_reset();   // 每 32KB 喂狗（不能用 remain%32768，非整数倍时永不命中）
  }
  unsigned char out[32];
  SHA256_FINISH(&ctx, out);
  mbedtls_sha256_free(&ctx);

  if (!ok) { Update.abort(); http.end(); Serial.println("[OTA] 下载中断，已回滚"); return false; }
  http.end();

  String hex;
  for (int i = 0; i < 32; i++) { char b[3]; snprintf(b, sizeof(b), "%02x", out[i]); hex += b; }
  if (!constantTimeEq(hex, String(expectSha))) {
    Update.abort();
    Serial.printf("[OTA] 摘要不匹配，已回滚（期望 %.8s… 实际 %.8s…）\n", expectSha, hex.c_str());
    return false;
  }
  if (!Update.end(true)) {
    Serial.printf("[OTA] 写入失败 err=%u\n", Update.getError());
    return false;
  }
  Serial.println("[OTA] 校验通过，重启进入新固件");
  delay(300);
  ESP.restart();
  return true;
}

/* 场景快照上报：检测到可疑场景时上传传感器快照，由后台 AI/规则引擎判断 */
void publishSnap() {
  StaticJsonDocument<640> doc;
  doc["id"] = DEVICE_ID;
  doc["ts"] = nowEpoch();
  doc["tsConf"] = timeReady ? "synced" : "unset";
  doc["seq"] = (unsigned long)esp_random();
  JsonObject sensors = doc.createNestedObject("sensors");
  collectSensors(sensors);
  doc["personPresent"] = sen.presence;
  doc["cooking"] = sen.cooking;
  doc["sinceCookStartSec"] = sen.cooking ? (unsigned long)((millis() - sen.cookStartMs) / 1000UL) : 0;
  doc["cookingSource"] = "radar+temp+gas";    // 判定依据，后台可追溯
  signReport(doc, "snap");
  char buf[640];
  serializeJson(doc, buf);
  mqtt.publish(topic("snap").c_str(), buf);
  Serial.println("[SNAP] 场景快照已上传（等待后台场景判定）");
}

/* 处理后台下行指令 */
void onCmd(const String& payload) {
  StaticJsonDocument<1024> doc;
  if (deserializeJson(doc, payload.c_str())) {
    Serial.println("[SEC] 指令 JSON 解析失败，已丢弃");
    return;
  }
  const char* cmd   = doc["cmd"]   | "";
  const char* nonce = doc["nonce"] | "";

  /* 安全门：验签失败一律不执行（防伪造、防重放），并回执说明原因 */
  String why;
  if (!verifyCmdSig(doc.as<JsonObject>(), cmd, why)) {
    Serial.printf("[SEC] 拒绝 %s：%s\n", cmd, why.c_str());
    localEvent("security", "warn", ("指令被拒: " + String(cmd) + " " + why).c_str());
    publishAck(cmd, false, why.c_str(), nonce);
    return;
  }

  if (strcmp(cmd, "devmode") == 0) {
    devmode = doc["on"] | false;
    int ttl = doc["ttl"] | 1800;
    devmodeUntil = devmode ? millis() + (unsigned long)ttl * 1000 : 0;
    publishStatus();
    Serial.printf("[CMD] 开发者模式=%d，TTL=%ds\n", devmode, ttl);
  } else if (strcmp(cmd, "diag") == 0) {
    publishDiag();
  } else if (strcmp(cmd, "poweroff") == 0) {
    poweredOff = true;
    Serial.println("[CMD] 收到关机指令：停止检测与播报，进入关机待机（保留 MQTT 监听，可远程开机）");
    publishStatus();
  } else if (strcmp(cmd, "poweron") == 0) {
    poweredOff = false;
    Serial.println("[CMD] 收到开机指令：恢复全部检测与播报");
    publishStatus();
  } else if (strcmp(cmd, "reboot") == 0) {
    Serial.println("[CMD] 收到重启指令：软重启（配置保留）");
    publishAck(cmd, true, "即将重启", nonce);
    delay(200);
    ESP.restart();
  } else if (strcmp(cmd, "ota") == 0) {
    const char* url = doc["url"] | "";
    const char* ver = doc["version"] | "";
    const char* sha = doc["sha256"] | "";
    Serial.printf("[CMD] OTA → v%s\n", ver);
    publishAck(cmd, true, "开始下载固件", nonce);
    bool ok = otaFromUrl(url, sha);          // 成功会直接重启，不返回
    publishAck(cmd, false, ok ? "已完成但未重启" : "OTA 失败，已保留旧固件", nonce);
    return;
  } else if (strcmp(cmd, "set_params") == 0) {
    // 数值钳制：与后台同一套合法范围，防无效/越界参数写入 NVS（真机最后防线）
    JsonObject p = doc["params"];
    if (p["fire_detect_window"]) params.fire_detect_window = constrain((int)p["fire_detect_window"], 5, 600);
    if (p["fire_sigma"]) params.fire_sigma = constrain((int)p["fire_sigma"], 1, 20);
    if (p["leak_confirm_sec"]) params.leak_confirm_sec = constrain((int)p["leak_confirm_sec"], 1, 600);
    if (p["steam_exclude_sec"]) params.steam_exclude_sec = constrain((int)p["steam_exclude_sec"], 1, 600);
    if (p["remind_interval_sec"]) params.remind_interval_sec = constrain((int)p["remind_interval_sec"], 10, 3600);
    if (p["stove_timeout_sec"]) params.stove_timeout_sec = constrain((int)p["stove_timeout_sec"], 10, 7200);
    if (p["pet_confirm_sec"]) params.pet_confirm_sec = constrain((int)p["pet_confirm_sec"], 10, 3600);
    if (p["low_battery_v"]) params.low_battery_v = constrain((float)p["low_battery_v"], 2.5f, 4.5f);
    prefs.putBytes("params", &params, sizeof(params)); // NVS 持久化
    Serial.println("[CMD] 触发参数已更新并持久化（数值已按范围钳制）");
    publishStatus();
  } else if (strcmp(cmd, "set_voice") == 0) {
    JsonObject v = doc["voice"];
    if (v["gas_leak"]) voice.gas_leak = (const char*)v["gas_leak"];
    if (v["forgot_stove"]) voice.forgot_stove = (const char*)v["forgot_stove"];
    if (v["low_battery"]) voice.low_battery = (const char*)v["low_battery"];
    if (v["test_ok"]) voice.test_ok = (const char*)v["test_ok"];
    persistVoice(); // 4 条话术全量持久化，重启不丢失
    Serial.println("[CMD] 语音话术已更新并持久化");
    publishStatus();
  } else if (strcmp(cmd, "set_workflow") == 0) {
    // 后台「AI 与工作流」页下发：工作流步骤数组 + 版本 + AI 配置
    // 主固件应解析 doc["workflow"] 各步骤的 enabled/params 驱动检测状态机，此处仅保存版本号
    workflowVersion = String((int)doc["version"]);
    workflowLoaded = true;
    if (doc["ai"]["enabled"]) aiEnabled = doc["ai"]["enabled"];
    prefs.putString("wf_version", workflowVersion);
    prefs.putBool("wf_loaded", workflowLoaded);
    Serial.printf("[CMD] 检测工作流已更新 v%s（AI=%d），开始周期上传场景快照\n",
                  workflowVersion.c_str(), aiEnabled);
    publishStatus();
  } else if (strcmp(cmd, "set_volume") == 0) {
    // 后台「语音设置」下发：音量 0~100，真实调节播报响度
    // ESP32-C3 + MAX98357A（I2S 功放）示例：AUDIO_CLASS 使用 I2S 数字增益，
    // 真机实现时调用 setVolume()（如 audio.setVolume(vol*2.55) 或 I2S attenuation 寄存器），
    // 此处保存 NVS 并在播报话术前应用：
    int vol = (int)doc["volume"] | 80;
    vol = constrain(vol, 0, 100);
    prefs.putInt("volume", vol);
    Serial.printf("[CMD] 播报音量已调整为 %d%%（MAX98357A 增益随之变化）\n", vol);
    publishStatus();
  } else if (strcmp(cmd, "set_wifi") == 0) {
    // 后台「设备页 WiFi 配置」下发：保存 SSID/密码，交给状态机异步重连（不再阻塞 20s）
    const char* ssid = doc["ssid"] | "";
    const char* pass = doc["pass"] | "";
    if (strlen(ssid) > 0 && strlen(ssid) <= 32 && strlen(pass) <= 64) {   // 与配网页同规则钳制
      prefs.putString("wifi_ssid", ssid);
      prefs.putString("wifi_pass", pass);
      Serial.printf("[CMD] WiFi 配置已保存：%s（非阻塞重连）\n", ssid);
      WiFi.disconnect();
      wifiState = WIFI_IDLE;
      wifiRetryCount = 0;
      wifiBackoffMs = 5000;
    } else {
      publishAck(cmd, false, "SSID≤32 位，密码≤64 位", nonce);
      return;
    }
  } else {
    publishAck(cmd, false, "未知指令", nonce);
    return;
  }
  publishStatus();
  publishAck(cmd, true, "已执行", nonce);
}

void mqttCallback(char* topic, byte* payload, unsigned int len) {
  String msg;
  for (unsigned int i = 0; i < len; i++) msg += (char)payload[i];
  onCmd(msg);
}

unsigned long lastMqttRetry = 0;
unsigned long mqttBackoffMs = 5000;
int mqttRetryCount = 0;

void connectMqtt() {
  if (mqtt.connected()) return;
  if (wifiState != WIFI_UP) return;          // 网络没起来就不空转重连
  unsigned long now = millis();
  if (now - lastMqttRetry < mqttBackoffMs) return;
  lastMqttRetry = now;
  bool ok = strlen(MQTT_USER) > 0 ? mqtt.connect(DEVICE_ID, MQTT_USER, MQTT_PASS)
                                  : mqtt.connect(DEVICE_ID);
  if (ok) {
    mqttRetryCount = 0;
    mqttBackoffMs = 5000;
    Serial.println("[MQTT] 已连接，订阅指令通道");
    mqtt.subscribe(topic("cmd").c_str());
    if (!timeReady) syncTimeAnchor();
    publishStatus();
  } else {
    mqttRetryCount++;
    int sh = mqttRetryCount > 5 ? 5 : mqttRetryCount;
    mqttBackoffMs = 5000UL * (1UL << sh);            // 10/20/40/80/160/320s
    if (mqttBackoffMs > 300000UL) mqttBackoffMs = 300000UL;
    Serial.printf("[MQTT] 失败 rc=%d，%lus 后重试（不影响本地检测）\n",
                  mqtt.state(), mqttBackoffMs / 1000);
  }
}

void setup() {
  Serial.begin(115200);
  /* 传感器硬件初始化：所有读取都在后面按周期做，不在这里等 */
  Wire.begin(6, 7);                                  // SHT3X：SDA=GPIO6 / SCL=GPIO7
  Wire.setClock(100000);
  analogReadResolution(12);
  analogSetPinAttenuation(PIN_MQ, ADC_11db);
  analogSetPinAttenuation(PIN_LIGHT, ADC_11db);
  analogSetPinAttenuation(PIN_BAT, ADC_11db);
  analogSetPinAttenuation(PIN_MIC, ADC_11db);
  Serial1.begin(256000, SERIAL_8N1, RADAR_RX, RADAR_TX);   // LD2410C 默认 256000
  prefs.begin("kitchen", false);

  /* 1. 先定身份：后续所有 topic 都依赖它 */
  initDeviceId();

  /* 2. 参数读取：损坏或越界即恢复默认（防上电读到垃圾参数） */
  size_t plen = prefs.getBytes("params", &params, sizeof(params));
  if (plen != sizeof(params)) {
    params = Params();
    Serial.println("[NVS] params 损坏，已重置为默认值");
  } else if (!paramsValid(params)) {
    params = Params();
    Serial.println("[NVS] params 越界，已重置为默认值");
  }
  restoreVoice(); // 恢复 4 条语音话术（重启不丢失）

  /* 3. 指令签名密钥：NVS 优先，其次编译默认值 */
  String sk = prefs.getString("cmd_secret", "");
  if (sk.length() == 0) sk = String(CMD_SECRET_DEFAULT);
  sk.toCharArray(cmdSecret, sizeof(cmdSecret));
  if (strlen(cmdSecret) == 0) {
    Serial.println("[SEC] 未配置指令签名密钥：下行指令不做验签（仅调试可用，上线前必须配置）");
  } else {
    Serial.println("[SEC] 指令签名已启用，未签名/重放指令将被拒绝");
  }

  /* 3b. 上行数据签名密钥：NVS 优先 */
  String dsk = prefs.getString("dev_secret", "");
  if (dsk.length() == 0) dsk = String(DEV_SECRET_DEFAULT);
  dsk.toCharArray(devSecret, sizeof(devSecret));
  if (strlen(devSecret) == 0) {
    Serial.println("[SEC] 未配置上行数据签名：上报不带签名（后台兼容模式接受，建议烧录后配置）");
  } else {
    Serial.println("[SEC] 上行数据签名已启用，伪造上报会被后台丢弃");
  }

  /* 4. 看门狗先开：让任何后续死循环都能自恢复 */
  wdtInit();

  /* 5. 网络只起状态机，绝不在这里等待 —— 报警路径必须先于联网就绪 */
  WiFi.mode(WIFI_STA);
  wifiState = WIFI_IDLE;

  /* 5b. 配网服务器常驻：按键长按 3s 可随时重新配网；首次无 WiFi 凭据直接进配网模式 */
  pinMode(PROVISION_BUTTON_PIN, INPUT_PULLUP);
  setupProvisioningServer();
  if (prefs.getString("wifi_ssid", "").length() == 0) {
    Serial.println("[PROV] 未找到已保存的 WiFi：首次激活，进入配网模式（热点 XZL-…，配网页 192.168.4.1）");
    startProvisioning();
  }

  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(mqttCallback);
  mqtt.setBufferSize(MQTT_MAX_PACKET_SIZE);   // 与宏双保险，防大报文被截断
  bootTs = millis();
  Serial.printf("[BOOT] 固件 %s 启动完成，进入主循环（网络异步，本地检测立即可用）\n", fwVersion.c_str());
}

void loop() {
  esp_task_wdt_reset();     // 喂狗：能跑到这里说明主循环还活着

  pollSerialDbg();          // 有线调试：处理 USB 串口指令
  radarPoll();              // 雷达帧解析（非阻塞）
  readSensors();            // ADC / SHT3X 周期采样（2 秒）
  updateCooking();          // 做饭状态判定
  provServer.handleClient();// 配网页（热点模式；按键触发后同样可用）
  pollProvisionButton();    // 按键长按 3s → 重新进入配网
  if (provisioning && millis() >= provisionUntil) {
    Serial.println("[PROV] 配网超时，已关闭热点（再次长按按键可重新进入）");
    stopProvisioning();
  }
  wifiTick();               // 非阻塞 Wi-Fi 状态机

  if (!mqtt.connected()) connectMqtt();
  mqtt.loop();

  // 开发者模式 TTL 到期 → 自动退出恢复低功耗
  if (devmode && devmodeUntil && millis() > devmodeUntil) {
    devmode = false;
    devmodeUntil = 0;
    Serial.println("[DEV] 开发者模式超时，恢复低功耗");
  }

  // 收到工作流后：每 20s 上传场景快照，演示后台 AI/规则场景判断（开发者模式可加快）
  if (!poweredOff && workflowLoaded && millis() - lastSnap >= (devmode ? 5000 : 20000)) {
    lastSnap = millis();
    publishSnap();
  }

  unsigned long interval = devmode ? DEVMODE_INTERVAL_MS : NORMAL_INTERVAL_MS;
  if (millis() - lastHeartbeat >= interval) {
    lastHeartbeat = millis();
    publishStatus();
  }
}
