#!/usr/bin/env node
/**
 * Node 启动器：统一入口，兼容平台以 `node start.js` 或 `./start.js` 方式执行。
 * 实际部署逻辑（数据恢复、Git 备份循环、模拟器、前台服务）都在 render-start.sh 中。
 */
const { spawn } = require('child_process');
const path = require('path');

const dir = path.resolve(path.dirname(process.argv[1] || __filename));
const script = path.join(dir, 'render-start.sh');

const child = spawn('bash', [script], { cwd: dir, stdio: 'inherit' });

['SIGTERM', 'SIGINT', 'SIGHUP'].forEach((sig) => {
  process.on(sig, () => {
    try { child.kill(sig); } catch (_) {}
    // 不立即退出，等子进程收尾
  });
});

child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
