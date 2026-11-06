#!/bin/bash
# Render 专用启动脚本（前台常驻 + 数据恢复 + 后台备份循环）
# 在 Render 的 Start Command 里填: bash render-start.sh
# 环境变量:
#   GIT_DATA_REPO            数据备份仓库地址（可含 token）
#   GIT_DATA_BRANCH          分支（默认 main）
#   BACKUP_INTERVAL_SEC      备份间隔秒数（默认 300）
#   SIM=1                    启动模拟器做演示（默认不启动，避免伪造设备在线）
#   NO_SIM=1                 兼容旧变量：设为 1 时也不启动模拟器
cd "$(dirname "$0")"
mkdir -p data logs

# 启动自检：逐项探测关键依赖，每行简短避免日志截断
# 注意：部分模块（如 store）加载后会启动常驻定时器，必须 process.exit 强制退出
echo "[preflight] node $(node -v 2>/dev/null || echo MISS)"
for m in express mqtt ws esptool-js ./config ./store ./workflow ./diag; do
  if node -e "require('$m');process.exit(0)" 2>/dev/null; then echo "[preflight] OK $m"; else echo "[preflight] MISS $m"; fi
done
if command -v git >/dev/null 2>&1; then echo "[preflight] git ok"; else echo "[preflight] GIT MISSING"; fi

BRANCH="${GIT_DATA_BRANCH:-main}"

# 数据恢复/初始化（Git 备份开启时）
if [ -n "$GIT_DATA_REPO" ]; then
  if [ ! -d data/.git ]; then
    if [ -n "$(ls -A data 2>/dev/null | grep -v '^\.gitkeep$')" ]; then
      (cd data && git init -q && git config user.name "kitchen-admin" && git config user.email "kitchen-admin@render" \
        && git add -f -A . && git commit -qm "init data" && git branch -M "$BRANCH" && git remote add origin "$GIT_DATA_REPO") \
        && echo "[data] 本地数据已初始化并关联备份仓库" || echo "[data] ⚠️ 初始化失败"
    else
      rm -rf data && git clone -q -b "$BRANCH" "$GIT_DATA_REPO" data 2>/dev/null \
        && echo "[data] 已从备份仓库恢复" \
        || { mkdir -p data && (cd data && git init -q && git config user.name "kitchen-admin" && git config user.email "kitchen-admin@render" \
             && git branch -M "$BRANCH" && git remote add origin "$GIT_DATA_REPO"); echo "[data] 备份仓库为空，已新建"; }
    fi
  else
    (cd data && git config user.name "kitchen-admin" && git config user.email "kitchen-admin@render" \
      && git pull -q --rebase origin "$BRANCH" 2>/dev/null || git pull -q origin "$BRANCH") \
      && echo "[data] 数据已更新到最新" || echo "[data] ⚠️ 拉取失败"
  fi
  # 后台备份循环
  (
    while true; do
      sleep "${BACKUP_INTERVAL_SEC:-300}"
      # 每轮先确保提交身份（克隆/新建/拉取各路径都覆盖），仅当有数据变化时才提交推送
      if (cd data && git config user.name "kitchen-admin" && git config user.email "kitchen-admin@render" \
          && git add -f -A . && ! git diff --cached --quiet) 2>>logs/backup.log; then
        (cd data && git commit -qm "auto backup $(date '+%F %T')" && git push -q origin "$BRANCH") 2>>logs/backup.log \
          || echo "$(date '+%F %T') [backup] 推送失败，下周期重试" >> logs/backup.log
      fi
    done
  ) &
  echo "[backup] 后台备份已启动，每 ${BACKUP_INTERVAL_SEC:-300}s"
fi

# 模拟器（默认不启动：模拟器会伪造 A001~A003 心跳，让后台把「假在线」当真，
# 设备状态与真实完全脱钩。需要演示时显式设 SIM=1）
if [ "${SIM:-0}" = "1" ] && [ "${NO_SIM:-0}" != "1" ]; then
  node simulate/simulate.js --interval 30 >> logs/simulate.log 2>&1 &
  echo "[sim] 模拟器已启动（SIM=1）"
else
  echo "[sim] 模拟器未启动（真实设备模式）"
fi

# 前台运行后端（Render 需要主进程常驻监听 PORT）
exec node server.js
