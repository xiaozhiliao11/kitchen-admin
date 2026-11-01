#!/bin/bash
# kitchen-admin 便携启动脚本（适合本地电脑 / VPS / 树莓派 / Render / Glitch 等任何 Linux+Node 环境）
# 用法:
#   ./start.sh            启动全部（后端 + 3 台模拟设备 A001/A002/A003）
#   ./start.sh --no-sim   只启动后端（接真机设备时用）
#   ./start.sh --events   模拟器额外产生随机安全事件（忘关火/泄漏演示）
# 数据异地备份（可选，强烈推荐免费托管用）:
#   设置环境变量 GIT_DATA_REPO（GitHub 私有仓库地址，可含 token），启动时会自动把 data/ 恢复/初始化成 Git 工作树，
#   并后台每 BACKUP_INTERVAL_SEC 秒自动提交推送。详见 README-部署说明.md 第四节。
cd "$(dirname "$0")"
mkdir -p logs data

NO_SIM=0
SIM_EXTRA=""
for arg in "$@"; do
  case "$arg" in
    --no-sim) NO_SIM=1 ;;
    --events) SIM_EXTRA="$SIM_EXTRA --events" ;;
  esac
done

BRANCH="${GIT_DATA_BRANCH:-main}"

# 首次运行自动安装依赖
if [ ! -d node_modules ]; then
  echo "首次运行：安装依赖（npm install）..."
  npm install --no-audit --no-fund || { echo "❌ 依赖安装失败，请确认已安装 Node.js（>=16）"; exit 1; }
fi

echo "[停止旧进程]"
for p in $(pgrep -f "node server.js" 2>/dev/null); do kill -TERM "$p" 2>/dev/null; done
for p in $(pgrep -f "node simulate/simulate.js" 2>/dev/null); do kill -TERM "$p" 2>/dev/null; done
for p in $(pgrep -f "data-backup.sh" 2>/dev/null); do kill -TERM "$p" 2>/dev/null; done
sleep 1

# 数据恢复/初始化（Git 备份开启时）
if [ -n "$GIT_DATA_REPO" ]; then
  echo "[0/2] 数据备份仓库处理中..."
  if [ ! -d data/.git ]; then
    if [ -n "$(ls -A data 2>/dev/null | grep -v '^\.gitkeep$')" ]; then
      # 本地已有数据 → 原地转成 Git 仓库并关联远端
      (cd data && git init -q && git add -A && git commit -qm "init data" && git branch -M "$BRANCH" && git remote add origin "$GIT_DATA_REPO") \
        && echo "      本地数据已初始化并关联备份仓库" \
        || echo "      ⚠️ 本地数据转 Git 仓库失败（不影响启动）"
    else
      # 全新 → 尝试从备份仓库拉取；仓库为空时本地新建
      rm -rf data && git clone -q -b "$BRANCH" "$GIT_DATA_REPO" data 2>/dev/null \
        && echo "      已从备份仓库恢复数据" \
        || { mkdir -p data && (cd data && git init -q && git branch -M "$BRANCH" && git remote add origin "$GIT_DATA_REPO"); echo "      备份仓库为空，已新建数据仓库"; }
    fi
  else
    # 已关联 → 拉取最新
    (cd data && git pull -q --rebase origin "$BRANCH" 2>/dev/null || git pull -q origin "$BRANCH") \
      && echo "      数据已更新到最新" || echo "      ⚠️ 数据拉取失败（不影响启动）"
  fi
fi

echo "[1/2] 启动后端服务..."
setsid nohup node server.js >> logs/server.log 2>&1 < /dev/null &
echo "      http://localhost:${PORT:-3000}"

if [ "$NO_SIM" = "0" ]; then
  echo "[2/2] 启动模拟器（A001/A002/A003）..."
  setsid nohup node simulate/simulate.js --interval 30 $SIM_EXTRA >> logs/simulate.log 2>&1 < /dev/null &
else
  echo "[2/2] 已跳过模拟器（--no-sim）"
fi

# 数据自动备份（后台循环，每 BACKUP_INTERVAL_SEC 秒提交推送一次）
if [ -n "$GIT_DATA_REPO" ]; then
  setsid nohup bash tools/data-backup.sh > /dev/null 2>&1 < /dev/null &
  echo "[备份] 已启动：每 ${BACKUP_INTERVAL_SEC:-300} 秒自动备份到 ${GIT_DATA_REPO%%@*}"
fi

echo
echo "✅ 启动完成"
echo "本地访问: http://localhost:${PORT:-3000}"
echo "公网访问: 取决于你的部署平台（VPS 配域名 / 免费托管平台给固定网址）"
echo
echo "停止全部: pkill -f 'node server.js'; pkill -f 'node simulate/simulate.js'; pkill -f 'data-backup.sh'"
