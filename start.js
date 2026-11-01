#!/usr/bin/env node
/**
 * Node 启动器：统一入口，兼容平台以 `node start.js` 或 `./start.js` 方式执行。
 * 实际部署逻辑（数据恢复、Git 备份循环、模拟器、前台服务）都在 render-start.sh 中。
 */
const { spawn } = require('child_process');
const path = require('path');

const dir = path.resolve(path.dirname(process.argv[1] || __filename));
const script = path.join(dir, 'render-start.sh');

// 优先 bash，缺失时回退 sh（alpine 精简镜像可能无 bash）
const shell = process.env.START_SHELL || 'bash';

const child = spawn(shell, [script], { cwd: dir, stdio: 'inherit' });

child.on('error', (err) => {
  console.error(`[start] 无法启动 ${shell}: ${err.message}`);
  if (shell !== 'sh') {
    console.error('[start] 回退到 sh 重试');
    const fallback = spawn('sh', [script], { cwd: dir, stdio: 'inherit' });
    fallback.on('error', (e2) => {
      console.error(`[start] sh 也无法启动: ${e2.message}`);
      process.exit(1);
    });
    fallback.on('exit', (code, signal) => {
      process.exit(code ?? (signal ? 1 : 0));
    });
    return;
  }
  process.exit(1);
});

['SIGTERM', 'SIGINT', 'SIGHUP'].forEach((sig) => {
  process.on(sig, () => {
    try { child.kill(sig); } catch (_) {}
    // 不立即退出，等子进程收尾
  });
});

child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
