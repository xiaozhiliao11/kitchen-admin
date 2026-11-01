# kitchen-admin 部署说明（解压即跑版）

> 厨房AI安全提醒仪 · 多主机后台管理系统（Node.js + Express + MQTT + WebSocket + JSON 落盘）
> 本包已剔除密钥/依赖缓存/运行日志，**不包含任何账号密码或令牌**，可放心分发。

## 一、运行要求

- **Node.js ≥ 16**（推荐 18+）：官网 https://nodejs.org 下载 LTS 版
- npm（装 Node 自带）
- 无需数据库、无需备案、无需绑卡

## 二、部署方式（选一个）

### 方式 A：本地电脑 / 树莓派 / 任意 Linux（最快体验）
```bash
unzip kitchen-admin-deploy.zip
cd kitchen-admin-deploy
./start.sh          # 首次会自动 npm install，然后启动
```
打开浏览器访问 `http://localhost:3000`。局域网内其他设备访问用 `http://你的电脑IP:3000`。

### 方式 B：海外 VPS（长期稳定，约 ¥20~30/月，支付宝可付、免备案）
1. 买一台香港/新加坡/东京的小 VPS（1C1G 即可，支付宝付款，**不需要银行卡**）
2. 把整个文件夹传上去（`scp -r kitchen-admin-deploy root@服务器IP:/opt/`）
3. SSH 进去执行：
   ```bash
   cd /opt/kitchen-admin-deploy
   ./start.sh
   ```
4. 配固定网址：买个几块钱的域名（.top/.xyz）→ DNS 加 A 记录指向 VPS 公网 IP，用 Nginx/Caddy 反代到 3000 端口（或面板/宝塔一键反代）。
5. 要 7×24 自动恢复：加 crontab（见第六节"自愈"）。

### 方式 C：免费 Node 托管平台（Render / Glitch）
- **Render**（onrender.com，免费层）：注册用 GitHub 登录（不绑卡），把本目录源码推到你的 GitHub 仓库后，Render 连仓库部署，启动命令填 `bash start.sh`（或 `node server.js`），平台自动给固定网址 `xxx.onrender.com`。免费额度 750 小时/月 ≈ 一台实例 24/7。
- **Glitch**：免费，支持直接上传文件，网址 `xxx.glitch.me` 固定。
- ⚠️ **免费层两个硬伤**（务必知道）：
  1. **15 分钟无访问会休眠**，唤醒要等几十秒 → 用 **UptimeRobot**（免费）每 10 分钟 ping 一次防休眠；
  2. **磁盘是临时的**，重启/平台回收会丢 `data/` 数据 → **用本包自带 Git 备份解决**（见第四节）。
- WebSocket 与 MQTT 出站连接均可用。`onrender.com` / `glitch.me` 在国内一般可直接访问（速度以实测为准）。

### 方式 D：接真机硬件
模拟器和真机都用 `dev/设备ID` 前缀的 MQTT topic。接真机时启动 `./start.sh --no-sim`（避免占用 A001~A003 演示 ID），并把固件烧录到设备即可。

## 三、常用配置（环境变量，部署平台里配置）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | HTTP 端口（托管平台通常会自动注入） |
| `MQTT_URL` | `mqtt://broker.emqx.io:1883` | MQTT Broker 地址（可换自己的私有 Broker） |
| `MQTT_USER` / `MQTT_PASS` | 空 | 私有 Broker 账号密码 |
| `MQTT_TOPIC_PREFIX` | `dev/` | 设备 topic 前缀 |
| `DATA_DIR` | `./data` | 数据落盘目录（Git 备份时建议保持默认） |
| `INITIAL_DEVICES` | `A001,A002,A003` | 首次启动自动注册的演示设备 |
| `OFFLINE_AFTER_MS` | `90000` | 心跳超时判离线毫秒数 |
| `AI_API_KEY` 等 | 空 | 可选：大模型增强故障分析 |
| `GIT_DATA_REPO` | 空 | 数据备份仓库地址（见第四节） |
| `GIT_DATA_BRANCH` | `main` | 备份仓库分支 |
| `BACKUP_INTERVAL_SEC` | `300` | 数据备份间隔秒数 |

## 四、数据自动备份到 Git（免费托管丢数据的解药）

免费托管磁盘临时，重启就丢数据。本包内置了"数据自动备份"，**每次改动最多丢 5 分钟**（间隔可调），实例重启后启动时自动把数据拉回来。

**一次性配置（约 5 分钟）：**

1. **GitHub 建一个私有仓库**：登录 GitHub → New repository → 名字如 `kitchen-data` → 选 **Private** → 创建。
2. **生成一个专属访问令牌**：GitHub → 头像 → Settings → Developer settings → **Personal access tokens** → **Fine-grained tokens** → Generate new token：
   - Repository access：选 **Only select repositories** → 勾选刚建的 `kitchen-data`
   - Permissions → Repository permissions → **Contents: Read and write**
   - 生成后**复制令牌**（只显示一次）
3. **在部署平台设 3 个环境变量**（Render: 项目 Settings → Environment；Glitch: 项目 .env）：
   ```
   GIT_DATA_REPO=https://<刚复制的令牌>@github.com/<你的GitHub用户名>/kitchen-data.git
   GIT_DATA_BRANCH=main
   BACKUP_INTERVAL_SEC=300
   ```
4. 重新部署/启动即可。**生效逻辑**：
   - 首次启动：本地无数据 → 自动从仓库拉取（仓库为空就新建）；
   - 运行中：每 5 分钟自动 `git add/commit/push` 到私有仓库；
   - 实例重启：启动时自动 `git pull` 把数据拉回来，再启动服务。

**安全提醒**：令牌有该仓库写权限，**不要发给任何人、不要写进代码或提交到公开仓库**；它只存在部署平台的密钥环境变量里（令牌藏在仓库地址中，不会出现在 `data/` 的提交内容里）。

**自检**：启动后看 `logs/backup.log`，出现"提交/推送失败"说明令牌或仓库配置有问题；GitHub 仓库里能看到 `devices.json` / `events.json` / `settings.json` 的更新记录即成功。

## 五、健康检查

```bash
curl http://localhost:3000/api/health
# 期望: {"ok":true,"mqtt":true,"devices":3}
```

## 六、自愈（可选，推荐 VPS 用）

每分钟检查 + 开机自启，挂掉自动拉起：
```bash
crontab -e
# 追加两行：
* * * * * /opt/kitchen-admin-deploy/start.sh --no-sim >> /opt/kitchen-admin-deploy/logs/start.log 2>&1
@reboot sleep 15 && /opt/kitchen-admin-deploy/start.sh --no-sim >> /opt/kitchen-admin-deploy/logs/start.log 2>&1
```
> `start.sh` 幂等（重复执行会先停旧进程再拉起），放每分钟 crontab 即是看护；接真机用 `--no-sim`。免费托管平台则用 UptimeRobot 防休眠。

## 七、常见问题

- **端口被占用**：先 `pkill -f "node server.js"`，或设 `PORT=8080 ./start.sh`
- **模拟设备不上线**：MQTT 公共 Broker 偶发波动，稍等重试或换 `MQTT_URL`
- **想清空数据重来**：删掉 `data/` 目录重启即可（首次启动会重新注册 A001~A003）
- **Git 备份报错**：先查令牌是否过期/被撤销、仓库名和用户名是否写对；`data/` 里的提交记录可用 `git -C data log --oneline` 查看
