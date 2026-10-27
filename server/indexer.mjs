/**
 * 索引任务：通过 MCP over HTTP 让索引服务解析一个代码目录，产出图数据库。
 *
 * 单任务串行：同一时刻只跑一个索引（解析本身很吃 CPU，并发没有收益）。
 * 任务状态与日志放在进程内存里，前端轮询 /api/index/status 取快照。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as store from './db.mjs';
import { effective, saveConfig } from './config.mjs';
import { createSession, probeService } from './mcp.mjs';

const MODE_LABEL = { full: '完整（结构 + 语义）', moderate: '适中（过滤 + 语义）', fast: '快速（只做结构）' };
const MAX_LOG = 600;

function blank() {
  return {
    id: 0,
    state: 'idle', // idle | running | done | failed | canceled
    stage: '',
    repoPath: '',
    mode: 'full',
    name: '',
    project: '',
    elapsedMs: 0,
    startedAt: '',
    finishedAt: '',
    error: '',
    result: null,
    log: [],
    logTotal: 0,
  };
}

let job = blank();
let session = null;
let canceled = false;

const now = () => new Date().toISOString();
const ms = () => Date.now();

function push(level, text) {
  job.log.push({ t: now(), level, text: String(text).slice(0, 1200) });
  if (job.log.length > MAX_LOG) job.log.splice(0, job.log.length - MAX_LOG);
  job.logTotal += 1;
}

function stage(key, text) {
  job.stage = key;
  if (text) push('stage', text);
}

export function status() {
  return {
    ...job,
    log: job.log.slice(-220),
    logTotal: job.logTotal,
  };
}

export function isRunning() {
  return job.state === 'running';
}

export function cancel() {
  if (job.state !== 'running') return { ok: false, message: '当前没有正在跑的索引' };
  canceled = true;
  push('warn', '已请求取消：正在关闭 MCP 会话…');
  try {
    session?.close();
  } catch {
    /* ignore */
  }
  session = null;
  job.state = 'canceled';
  job.finishedAt = now();
  job.elapsedMs = ms() - Date.parse(job.startedAt || now());
  return { ok: true, message: '已取消' };
}

/** 索引服务诊断：按配置的传输方式（http / stdio）做一次真实探测 */
export async function mcpStatus() {
  const cfg = effective();
  const cacheDir = store.cacheDir() ?? cfg.cbm.cacheDir ?? '';
  const probe = await probeService(cfg, { cacheDir });
  return {
    transport: cfg.cbm.transport,
    endpoint: cfg.cbm.endpoint,
    tokenSet: !!cfg.cbm.token,
    exePath: cfg.cbm.exePath,
    cacheDir,
    probe,
    running: isRunning(),
  };
}

/** 把路径归一化后比较，避免 D:/a 与 d:\a 被当成两个项目 */
const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/**
 * 启动一次索引。立即返回任务快照，实际解析在后台跑。
 */
export function start(input = {}) {
  if (isRunning()) {
    const err = new Error('已有索引任务在运行，请先等它结束或点「取消」');
    err.status = 409;
    throw err;
  }

  const cfg = effective();
  const repoPath = String(input.repoPath ?? cfg.index.repoPath ?? '').trim();
  const mode = ['full', 'moderate', 'fast'].includes(input.mode) ? input.mode : cfg.index.mode;
  const name = String(input.name ?? '').trim();

  if (!repoPath) throw new Error('请先选择或填写代码库根路径');
  const abs = path.resolve(repoPath);
  if (!fs.existsSync(abs)) throw new Error(`路径不存在：${abs}`);
  if (!fs.statSync(abs).isDirectory()) throw new Error(`不是一个目录：${abs}`);

  canceled = false;
  job = {
    ...blank(),
    id: job.id + 1,
    state: 'running',
    stage: 'start',
    repoPath: abs,
    mode,
    name,
    startedAt: now(),
  };
  push('info', `开始索引 ${abs}`);
  push('info', `模式：${MODE_LABEL[mode] ?? mode}`);
  push('info', `索引服务：${cfg.cbm.endpoint}`);

  // 记住本次选择，下次打开配置页不用重选
  try {
    saveConfig({ index: { repoPath: abs, mode, name } });
  } catch (err) {
    push('warn', `选择未能写回配置：${err.message ?? err}`);
  }

  void run(abs, mode, name).catch((err) => {
    if (canceled) return;
    job.state = 'failed';
    job.error = String(err?.message ?? err);
    job.finishedAt = now();
    job.elapsedMs = ms() - Date.parse(job.startedAt);
    push('error', job.error);
    try {
      session?.close();
    } catch {
      /* ignore */
    }
    session = null;
  });

  return status();
}

async function run(abs, mode, name) {
  const cfg = effective();

  /* 0. 先放开本地图库句柄：索引落库时会重写文件，读端占着会失败 */
  store.resetConnections();
  push('info', '已释放本地图库连接（避免索引落库时文件被占用）');

  /* 1. 建立 MCP 会话（http 或 stdio，由配置决定） */
  stage('connect', `连接索引服务（${cfg.cbm.transport}）…`);
  push('info', cfg.cbm.transport === 'stdio' ? `传输：stdio · 可执行文件：${cfg.cbm.exePath || '（自动探测）'}` : `传输：http · 端点：${cfg.cbm.endpoint}`);
  session = createSession(cfg, {
    cacheDir: store.cacheDir() ?? cfg.cbm.cacheDir ?? '',
    onLog: (level, text) => push(level === 'progress' ? 'progress' : 'mcp', text),
  });
  const info = await session.connect();
  if (canceled) return;
  push('info', `索引服务已就绪：${info?.name ?? 'codebase-memory'} ${info?.version ?? ''}`.trim());

  /* 3. 让索引服务解析代码 */
  stage('index', `正在解析代码（${MODE_LABEL[mode] ?? mode}）…`);
  const t0 = ms();
  const args = { repo_path: abs, mode };
  if (name) args.name = name;

  // 索引可能跑很久：超时交给配置里的 timeoutMs，而不是写死
  const res = await session.callTool('index_repository', args, effective().cbm.timeoutMs);
  if (canceled) return;
  const took = ms() - t0;
  const nodes = Number(res?.nodes ?? 0);
  const edges = Number(res?.edges ?? 0);
  push('ok', `解析完成：${nodes} 节点 / ${edges} 边（${(took / 1000).toFixed(1)}s）`);
  if (res?.skipped_count) push('info', `跳过文件：${res.skipped_count}`);
  if (res?.parse_partial_count) push('warn', `部分解析：${res.parse_partial_count} 个文件`);
  if (res?.parse_unusable_count) push('warn', `无法解析：${res.parse_unusable_count} 个文件`);

  /* 4. 回读项目，确认落库位置 */
  stage('read', '读取索引结果…');
  let project = String(res?.project ?? '');
  let rootPath = abs;
  let dbPath = '';
  let dbBytes = 0;
  try {
    const list = await session.callTool('list_projects', { format: 'json', detail: 'stats', limit: 500 }, 60000);
    const arr = Array.isArray(list) ? list : Array.isArray(list?.projects) ? list.projects : [];
    const hit =
      arr.find((p) => norm(p.root_path ?? p.rootPath) === norm(abs)) ??
      arr.find((p) => (p.name ?? '') === project) ??
      null;
    if (hit) {
      project = hit.name ?? project;
      rootPath = hit.root_path ?? hit.rootPath ?? abs;
      dbBytes = Number(hit.size_bytes ?? hit.sizeBytes ?? 0);
      if (hit.nodes !== undefined) push('info', `图库统计：${hit.nodes} 节点 / ${hit.edges} 边`);
    }
  } catch (err) {
    push('warn', `list_projects 回读失败（不影响索引结果）：${err.message ?? err}`);
  }

  session.close();
  session = null;

  /* 5. 让读取端重新连库 */
  store.resetConnections();
  const found = store.listProjects().find((p) => p.name === project);
  if (found) {
    dbPath = found.dbPath;
    dbBytes = found.dbBytes;
    rootPath = found.rootPath || rootPath;
    push('ok', `图数据库：${found.dbPath}（${found.nodes} 节点 / ${found.edges} 边）`);
  } else {
    push('warn', '图数据库已生成，但当前缓存目录里没读到它；请检查「图数据库目录」是否与 MCP 一致');
  }

  job.state = 'done';
  job.project = project;
  job.finishedAt = now();
  job.elapsedMs = ms() - Date.parse(job.startedAt);
  job.stage = 'done';
  job.result = {
    project,
    nodes: found?.nodes ?? nodes,
    edges: found?.edges ?? edges,
    rootPath,
    dbPath,
    dbBytes,
    mode,
    parseMs: took,
  };
  push('ok', `索引完成，用时 ${(job.elapsedMs / 1000).toFixed(1)}s`);

  try {
    saveConfig({ index: { lastProject: project } });
    store.resetConnections();
  } catch {
    /* 写回失败不影响索引结果 */
  }
}
