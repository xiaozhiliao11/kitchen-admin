# kitchen-admin 部署镜像（Suga/Render 通用）
# 强制 Node 构建，避免平台把仓库误判为静态 HTML
FROM node:20-alpine

WORKDIR /app

# 先装依赖（利用缓存层）
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

# 再拷源码
COPY . .

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# 前台常驻：恢复/初始化 data 并启动 Git 备份循环，再前台跑 server
CMD ["bash", "render-start.sh"]
