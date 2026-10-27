#!/usr/bin/env node
/**
 * 渲染自检入口：确保 API 在跑 → 用 vite 以 SSR 模式打包检查脚本 → 用 jsdom 执行。
 *   node scripts/check.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.PORT ?? '8787';
const API = `http://127.0.0.1:${PORT}`;

async function up() {
  try {
    const r = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

let child = null;
if (!(await up())) {
  console.log(`[check] API 未运行，临时启动 …`);
  child = spawn(process.execPath, ['--experimental-sqlite', 'server/index.mjs'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', () => {});
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 250));
    if (await up()) break;
  }
  if (!(await up())) {
    console.error('[check] API 启动失败');
    child?.kill();
    process.exit(1);
  }
}

const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
console.log('[check] 打包检查脚本（vite --ssr）…');
const build = spawnSync(process.execPath, [viteBin, 'build', '--ssr', 'scripts/render-check.tsx', '--outDir', '.check', '--emptyOutDir'], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  encoding: 'utf8',
});
if (build.status !== 0) {
  console.error(build.stdout?.slice(-1500) ?? '');
  console.error(build.stderr?.slice(-2500) ?? '');
  child?.kill();
  process.exit(1);
}

const out = path.join(ROOT, '.check', 'render-check.js');
if (!fs.existsSync(out)) {
  console.error(`[check] 未生成 ${out}`);
  const files = fs.existsSync(path.join(ROOT, '.check')) ? fs.readdirSync(path.join(ROOT, '.check')) : [];
  console.error('目录内容：', files.join(', ') || '(空)');
  child?.kill();
  process.exit(1);
}

const run = spawnSync(process.execPath, [out], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, API_BASE: API } });
child?.kill();
process.exit(run.status ?? 1);
