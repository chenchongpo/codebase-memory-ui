#!/usr/bin/env node
/**
 * 一键开发模式：同时拉起 API 服务（8787）与 Vite 开发服务器（5273）。
 * 只用 node:child_process，不引入 concurrently 之类的依赖。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const children = [];

function run(name, cmd, args, opts = {}) {
  // 注意：shell:true 时 Windows 会把 cmd 与 args 直接拼接且不做转义，
  // 因此 node 本体一律不走 shell（否则 "C:\Program Files\..." 会被空格截断），
  // 只有 npm.cmd 这类批处理才需要 shell。
  const shell = opts.shell ?? /\.cmd$|\.bat$/i.test(cmd);
  const child = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts, shell });
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) console.error(`[dev] ${name} 退出，code=${code}`);
  });
  children.push(child);
  return child;
}

console.log('[dev] 启动 API 服务 …');
run('api', process.execPath, ['--experimental-sqlite', 'server/index.mjs']);

setTimeout(() => {
  console.log('[dev] 启动 Vite …');
  run('vite', NPM, ['run', 'web']);
  console.log('\n  打开 http://127.0.0.1:5273  （Ctrl+C 结束）\n');
}, 900);

function shutdown() {
  for (const c of children) {
    try {
      c.kill();
    } catch {
      /* ignore */
    }
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
