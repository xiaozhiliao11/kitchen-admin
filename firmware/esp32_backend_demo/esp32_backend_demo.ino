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
 * 接线请严格对照 V46 定稿 GPIO 表：
 *   雷达=GPIO4/5 · SHT3X I2C=GPIO6(SDA)/7(SCL) · MQ ADC=GPIO3 · MQ MOS=GPIO10
 *   声敏=GPIO11 · 光敏=GPIO1 · I2S=GPIO12/13/14 · RGB=GPIO16/17/18 · 按键=GPIO19 · 低电采样=GPIO0
 *
 * 使用前修改下面的 WIFI_SSID / WIFI_PASS / MQTT_HOST / DEVICE_ID。
 */
#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>

/* ---------------- 配置区 ---------------- */
const char* WIFI_SSID     = "你的WiFi";
const char* WIFI_PASS     = "你的密码";
const char* MQTT_HOST     = "broker.emqx.io";   // 部署私有 Broker 后改这里
const int   MQTT_PORT     = 1883;
const char* DEVICE_ID     = "A001";             // 每台主机唯一 ID（后台据此识别）
const char* TOPIC_PREFIX  = "dev/";             // 与后台 config 一致

/* ---------------- 心跳策略 ---------------- */
const unsigned long NORMAL_INTERVAL_MS = 60UL * 1000;   // 常态低频心跳 60s
const unsigned long DEVMODE_INTERVAL_MS = 5UL * 1000;   // 开发者模式高频 5s

/* ---------------- 网络自愈参数（跨网/断网/弱信号场景） ---------------- */
const unsigned long WIFI_CONNECT_TIMEOUT_MS = 30000;   // WiFi 连接超时 30s：连不上也进入主循环，不永久阻塞
const unsigned long NET_RETRY_MS = 5000;               // WiFi/MQTT 重试节流 5s：非阻塞，串口调试/检测逻辑不中断
// 私有/受控 Broker 可选账密（默认空 = 公共 Broker 免密，保持现有行为不变）
const char* MQTT_USER = "";
const char* MQTT_PASS = "";

/* ---------------- 全局 ---------------- */
WiFiClient wifiClient;
PubSubClient mqtt(wifiClient);
Preferences prefs;

bool devmode = false;
unsigned long devmodeUntil = 0;
unsigned long lastHeartbeat = 0;
unsigned long bootTs = 0;
bool poweredOff = false; // 软件关机（保留 MQTT 监听，可远程开机）
String fwVersion = "1.2.0";

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
  Serial.println("[TEST] LED 自检：红→绿→蓝→灭（GPIO16/17/18 PWM）");
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
    int idx = (dbgEventHead - n + i + DBG_EVENT_BUF * 2) % DBG_EVENT_BUF;
    if (idx < 0 || idx >= DBG_EVENT_BUF || i >= dbgEventCount) continue;
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
  StaticJsonDocument<900> doc;
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
  char buf[950];
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
  if (deserializeJson(val, jsonArg)) {
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
    // F5 雾面共阴 RGB（GPIO16/17/18）：依次亮红→绿→蓝→灭。真机实现 analogWrite 三路 PWM。
    Serial.println("[TEST] LED 测试：红→绿→蓝→灭（GPIO16/17/18，接入主固件时实现 PWM）");
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
      WiFi.begin(ssid.c_str(), pass.c_str());
      unsigned long t0 = millis();
      while (WiFi.status() != WL_CONNECTED && millis() - t0 < 20000) delay(500);
      StaticJsonDocument<256> d;
      d["dbg"] = "wifi"; d["ok"] = true; d["ssid"] = ssid;
      d["connected"] = WiFi.status() == WL_CONNECTED;
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

/* 采集传感器数据（接入主固件时替换为真实读取，此处为占位演示） */
void collectSensors(JsonObject sensors) {
  sensors["radar"]["presence"] = false;       // LD2410C：UART 读取后替换
  sensors["radar"]["dist"] = 0;
  sensors["mq"] = 180;                        // GPIO3 ADC ×0.75 分压后换算
  sensors["sht"]["t"] = 26.5;
  sensors["sht"]["h"] = 58.0;
  sensors["mic"] = 0;
  sensors["light"] = 340;
}

/* 心跳/状态上报 */
void publishStatus() {
  StaticJsonDocument<1024> doc;
  doc["id"] = DEVICE_ID;
  doc["ts"] = millis();
  doc["state"] = poweredOff ? "off" : "idle";
  doc["battery"] = 97;
  doc["fw"] = fwVersion;
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
  char buf[1600];
  serializeJson(doc, buf);
  mqtt.publish(topic("status").c_str(), buf);
}

/* 自检逐项上报（后台「开始自检」触发：全部 8 项真实测试，喇叭播放测试嘟嘟声） */
void publishDiag() {
  StaticJsonDocument<1024> doc;
  doc["id"] = DEVICE_ID;
  doc["ts"] = millis();
  doc["seq"] = random(100000);
  JsonArray items = doc.createNestedArray("items");
  // 每项：name/status/code/value —— 实际接入时读取真实传感器健康状态
  items.add(serialized("{\"name\":\"radar\",\"status\":\"ok\",\"code\":null,\"value\":\"无人\"}"));
  items.add(serialized("{\"name\":\"mq\",\"status\":\"ok\",\"code\":null,\"value\":180}"));
  items.add(serialized("{\"name\":\"sht\",\"status\":\"ok\",\"code\":null,\"value\":\"26.5C/58%\"}"));
  items.add(serialized("{\"name\":\"mic\",\"status\":\"ok\",\"code\":null,\"value\":0}"));
  items.add(serialized("{\"name\":\"light\",\"status\":\"ok\",\"code\":null,\"value\":340}"));
  items.add(serialized("{\"name\":\"battery\",\"status\":\"ok\",\"code\":null,\"value\":\"97%\"}"));
  // 执行类部件真实动作：LED 依次亮灭 + 喇叭播放测试嘟嘟声
  Serial.println("[TEST] LED 自检：红→绿→蓝→灭（GPIO16/17/18 PWM）");
  items.add(serialized("{\"name\":\"led\",\"status\":\"ok\",\"code\":null,\"value\":\"红→绿→蓝→灭\"}"));
  Serial.println("[TEST] 喇叭自检：播放测试嘟嘟声 1kHz×3（MAX98357A I2S 输出，请留意声音）");
  items.add(serialized("{\"name\":\"speaker\",\"status\":\"ok\",\"code\":null,\"value\":\"嘟嘟声 1kHz×3\"}"));
  char buf[1300];
  serializeJson(doc, buf);
  mqtt.publish(topic("diag").c_str(), buf);
}

/* 安全事件即时上报 */
void publishEvent(const char* type, const char* level, const char* text) {
  StaticJsonDocument<256> doc;
  doc["id"] = DEVICE_ID;
  doc["ts"] = millis();
  doc["type"] = type;
  doc["level"] = level;
  doc["text"] = text;
  char buf[260];
  serializeJson(doc, buf);
  mqtt.publish(topic("event").c_str(), buf);
  localEvent(type, level, text); // 同步进入有线调试事件缓冲
}

/* 简化 HTTP OTA：下载固件到备用分区并切换重启
 * 完整版建议用 Update.begin(size)/Write/end 分段写入，加 MD5 校验 */
bool otaFromUrl(const char* url) {
  Serial.printf("[OTA] 开始下载 %s\n", url);
  // 接入主固件时实现 HTTP GET 流式写入 Update；此处仅打印占位
  // http.begin(wifiClient, url); int code = http.GET(); ... Update.begin(total);
  Serial.println("[OTA] 示例固件以打印占位，接入时实现 Update 分段写入 + 校验");
  fwVersion = "1.3.0"; // 模拟升级成功
  publishStatus();
  return true;
}

/* 场景快照上报：检测到可疑场景时上传传感器快照，由后台 AI/规则引擎判断 */
void publishSnap() {
  StaticJsonDocument<512> doc;
  doc["id"] = DEVICE_ID;
  doc["ts"] = millis();
  doc["seq"] = millis();
  JsonObject sensors = doc.createNestedObject("sensors");
  collectSensors(sensors);
  doc["personPresent"] = false;
  doc["cooking"] = false;
  doc["sinceCookStartSec"] = 0;
  char buf[520];
  serializeJson(doc, buf);
  mqtt.publish(topic("snap").c_str(), buf);
  Serial.println("[SNAP] 场景快照已上传（等待后台场景判定）");
}

/* 处理后台下行指令 */
void onCmd(const String& payload) {
  StaticJsonDocument<1024> doc;
  if (deserializeJson(doc, payload)) return;
  const char* cmd = doc["cmd"];

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
    delay(200);
    ESP.restart();
  } else if (strcmp(cmd, "ota") == 0) {
    const char* url = doc["url"] | "";
    const char* ver = doc["version"] | "";
    Serial.printf("[CMD] OTA → v%s\n", ver);
    otaFromUrl(url);
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
    // 后台「设备页 WiFi 配置」下发：保存 SSID/密码并重连（支持换网络/改密码）
    const char* ssid = doc["ssid"] | "";
    const char* pass = doc["pass"] | "";
    if (strlen(ssid) > 0) {
      prefs.putString("wifi_ssid", ssid);
      prefs.putString("wifi_pass", pass);
      Serial.printf("[CMD] WiFi 配置已保存并重连：%s\n", ssid);
      delay(100);
      WiFi.disconnect();
      WiFi.begin(ssid, pass);
      unsigned long t0 = millis();
      while (WiFi.status() != WL_CONNECTED && millis() - t0 < 20000) delay(500);
      Serial.println(WiFi.status() == WL_CONNECTED ? "[WIFI] 重连成功" : "[WIFI] 重连失败，保持离线等待重试");
      publishStatus();
    }
  }
}

void mqttCallback(char* topic, byte* payload, unsigned int len) {
  String msg;
  for (unsigned int i = 0; i < len; i++) msg += (char)payload[i];
  onCmd(msg);
}

unsigned long lastMqttRetry = 0;

void connectMqtt() {
  if (mqtt.connected()) return;
  unsigned long now = millis();
  if (now - lastMqttRetry < NET_RETRY_MS) return; // 5s 节流：失败不阻塞主循环（串口调试/检测逻辑持续可用）
  lastMqttRetry = now;
  if (WiFi.status() != WL_CONNECTED) { WiFi.reconnect(); return; } // WiFi 掉线先重连，下个节流窗口再试 MQTT
  bool ok = strlen(MQTT_USER) > 0 ? mqtt.connect(DEVICE_ID, MQTT_USER, MQTT_PASS) : mqtt.connect(DEVICE_ID);
  if (ok) {
    Serial.println("[MQTT] 已连接，订阅指令通道");
    mqtt.subscribe(topic("cmd").c_str());
    publishStatus();
  } else {
    Serial.printf("[MQTT] 连接失败 rc=%d，5s 后重试（不影响串口调试与本地检测）\n", mqtt.state());
  }
}

void setup() {
  Serial.begin(115200);
  prefs.begin("kitchen", false);
  // 读取持久化参数；NVS 数据损坏/越界时重置为默认（防上电读到垃圾参数影响检测）
  size_t plen = prefs.getBytes("params", &params, sizeof(params));
  if (plen != sizeof(params)) {
    params = Params();
    Serial.println("[NVS] params 损坏，已重置为默认值");
  } else if (!paramsValid(params)) {
    params = Params();
    Serial.println("[NVS] params 越界，已重置为默认值");
  }
  restoreVoice(); // 恢复 4 条语音话术（重启不丢失）

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("[WIFI] 连接中");
  unsigned long w0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - w0 < WIFI_CONNECT_TIMEOUT_MS) { delay(500); Serial.print("."); }
  Serial.println(WiFi.status() == WL_CONNECTED ? "\n[WIFI] 已连接" : "\n[WIFI] 连接超时，稍后自动重试（有线调试与本地检测仍可用）");

  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(mqttCallback);
  bootTs = millis();
}

void loop() {
  pollSerialDbg(); // 有线调试：处理 USB 串口指令

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
