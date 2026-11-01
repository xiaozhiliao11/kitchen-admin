#!/bin/bash
# kitchen-admin 数据自动备份循环
# 由 start.sh 在设置了 GIT_DATA_REPO 时后台启动。
# 每隔 BACKUP_INTERVAL_SEC（默认 300）秒，把 data/ 的改动提交并推送到备份仓库。
# 环境变量:
#   GIT_DATA_REPO            备份仓库地址（可含 token: https://TOKEN@github.com/用户/仓库.git）
#   GIT_DATA_BRANCH          分支（默认 main）
#   BACKUP_INTERVAL_SEC      备份间隔秒数（默认 300 = 5 分钟）
# 失败会自动跳过并在下一次周期重试，日志写 logs/backup.log
cd "$(dirname "$0")/.."
[ -z "$GIT_DATA_REPO" ] && exit 0
BRANCH="${GIT_DATA_BRANCH:-main}"
INTERVAL="${BACKUP_INTERVAL_SEC:-300}"
mkdir -p logs
while true; do
  sleep "$INTERVAL"
  if (cd data && git add -A && git commit -qm "auto backup $(date '+%F %T')" && git push -q origin "$BRANCH") 2>>logs/backup.log; then
    :
  else
    echo "$(date '+%F %T') [备份] 提交/推送失败，将在下个周期重试" >> logs/backup.log
  fi
done
