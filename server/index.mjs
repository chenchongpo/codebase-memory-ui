/**
 * Codebase Insight — 本地 API 服务
 *
 * 只读地打开 codebase-memory-mcp 生成的 SQLite 图数据库，向前端暴露 REST 接口。
 * 纯 Node 标准库（node:http + node:sqlite），无任何第三方依赖。
 *
 *   node --experimental-sqlite server/index.mjs              仅 API
 *   node --experimental-sqlite server/index.mjs --serve-dist  API + 托管 dist/
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import * as store from './db.mjs';
import * as q from './queries.mjs';
import * as fsbrowse from './fsbrowse.mjs';
import * as indexer from './indexer.mjs';
import { publicConfig, saveConfig, effective, configExists } from './config.mjs';
import { APP_ROOT, DIST_DIR } from './paths.mjs';

const ROOT = APP_ROOT;
const DIST = DIST_DIR;
const PORT = Number(process.env.PORT ?? 8787);
/** 默认只监听回环地址；内网部署时用 HOST=0.0.0.0 显式放开 */
const HOST = process.env.HOST ?? '127.0.0.1';
const SERVE_DIST = process.argv.includes('--serve-dist') || process.env.SERVE_DIST === '1';

/** 版本号以 package.json 为唯一来源，避免接口里写死后漂移 */
const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

function json(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function fail(res, err, status = 500) {
  json(res, { error: String(err?.message ?? err), stack: process.env.DEBUG ? String(err?.stack ?? '') : undefined }, status);
}

/** 统一取项目句柄 + 根路径（配置里的 sourceRoot 在库内路径失效时兜底） */
function ctx(params) {
  const eff = effective();
  const name = params.get('project') || eff.cbm.defaultProject;
  const list = store.listProjects();
  const project = name ? list.find((p) => p.name === name) : list[0];
  if (!project) throw new Error('没有可用的已索引项目（请先用 codebase-memory-mcp 索引一个仓库）');
  const override = eff.cbm.sourceRoot;
  const rootPath = override && (!project.rootPath || !fs.existsSync(project.rootPath)) ? override : project.rootPath;
  return { project, h: store.openDb(project.name), rootPath };
}

/** 探测目录 / 文件是否可用，供配置页「检测」按钮使用 */
function probe(target, kind) {
  const out = { path: target, kind, exists: false, isDir: false, dbCount: 0, databases: [], error: null };
  if (!target) return { ...out, error: '路径为空' };
  try {
    const st = fs.statSync(target);
    out.exists = true;
    out.isDir = st.isDirectory();
    if (kind === 'dir') {
      if (!out.isDir) return { ...out, error: '该路径不是目录' };
      const files = fs.readdirSync(target).filter((f) => f.endsWith('.db') && !f.startsWith('_'));
      out.dbCount = files.length;
      out.databases = files.slice(0, 20).map((f) => ({ file: f, bytes: fs.statSync(path.join(target, f)).size }));
      if (!files.length) out.error = '目录可访问，但没有找到 *.db 图数据库';
    } else if (!st.isFile()) {
      out.error = '该路径不是文件';
    }
  } catch (err) {
    out.error = err.code === 'ENOENT' ? '路径不存在' : String(err.message ?? err);
  }
  return out;
}

const ROUTES = {
  '/api/health': () => ({ ok: true, cacheDir: store.cacheDir(), version: VERSION, serveDist: SERVE_DIST, configExists: configExists() }),

  '/api/config': () => publicConfig(),
  '/api/config/probe': (p) => probe(p.get('path') ?? '', p.get('kind') === 'file' ? 'file' : 'dir'),

  /* ---- 目录浏览（配置页「选择代码文件夹」） ---- */
  '/api/fs/list': (p) => fsbrowse.listDir(p.get('path') ?? '', { showHeavy: p.get('showHeavy') === '1' }),

  /* ---- MCP / 索引 ---- */
  '/api/mcp/status': () => indexer.mcpStatus(),
  '/api/index/status': () => indexer.status(),

  '/api/projects': () => ({ cacheDir: store.cacheDir(), projects: store.listProjects() }),

  '/api/overview': (p) => {
    const { h, rootPath } = ctx(p);
    return q.overview(h, rootPath);
  },
  '/api/complexity': (p) =>
    q.complexity(ctx(p).h, {
      module: p.get('module') ?? '',
      bucket: p.get('bucket') ?? '',
      kind: p.get('kind') ?? '',
      test: p.get('test') ?? '',
      q: p.get('q') ?? '',
      sort: p.get('sort') ?? 'complexity',
      page: p.get('page') ? Number(p.get('page')) : undefined,
      pageSize: p.get('pageSize') ? Number(p.get('pageSize')) : undefined,
      all: p.get('all') === '1',
      slim: p.get('slim') === '1',
    }),
  '/api/duplicates': (p) => q.duplicates(ctx(p).h),
  '/api/architecture': (p) => {
    const { h, rootPath } = ctx(p);
    return q.architecture(h, rootPath);
  },
  '/api/layers': (p) => q.layers(ctx(p).h),
  '/api/chains': (p) =>
    q.callChains(ctx(p).h, {
      q: p.get('q') ?? '',
      id: p.get('id') ? Number(p.get('id')) : undefined,
      dir: p.get('dir') ?? 'up',
      depth: p.get('depth') ? Number(p.get('depth')) : undefined,
      limit: p.get('limit') ? Number(p.get('limit')) : undefined,
    }),
  '/api/browse': (p) =>
    q.browse(ctx(p).h, {
      level: p.get('level') ?? 'module',
      module: p.get('module') ?? '',
      pkg: p.get('pkg') ?? '',
      classId: p.get('classId') ? Number(p.get('classId')) : undefined,
      q: p.get('q') ?? '',
      page: p.get('page') ? Number(p.get('page')) : undefined,
      pageSize: p.get('pageSize') ? Number(p.get('pageSize')) : undefined,
    }),
  '/api/routes': (p) =>
    q.routes(ctx(p).h, {
      module: p.get('module') ?? '',
      http: p.get('http') ?? '',
      q: p.get('q') ?? '',
      sort: p.get('sort') ?? 'route',
      page: p.get('page') ? Number(p.get('page')) : undefined,
      pageSize: p.get('pageSize') ? Number(p.get('pageSize')) : undefined,
      all: p.get('all') === '1',
    }),
  '/api/coverage': (p) => q.coverage(ctx(p).h),
  '/api/deadcode': (p) => {
    const { h, rootPath } = ctx(p);
    return q.deadcode(h, {
      rootPath,
      module: p.get('module') ?? '',
      kind: p.get('kind') ?? '',
      risk: p.get('risk') ?? '',
      q: p.get('q') ?? '',
      sort: p.get('sort') ?? 'loc',
      page: p.get('page') ? Number(p.get('page')) : undefined,
      pageSize: p.get('pageSize') ? Number(p.get('pageSize')) : undefined,
      all: p.get('all') === '1',
      limit: p.get('limit') ? Number(p.get('limit')) : undefined,
    });
  },
  '/api/search': (p) => q.search(ctx(p).h, p.get('q') ?? '', p.get('limit') ? Number(p.get('limit')) : 40),
  '/api/node': (p) => q.nodeDetail(ctx(p).h, Number(p.get('id'))),
  '/api/graph': (p) =>
    q.graph(ctx(p).h, {
      limit: p.get('limit') ? Number(p.get('limit')) : undefined,
      labels: p.get('labels') ? p.get('labels').split(',') : undefined,
    }),
  '/api/source': (p) => {
    const { rootPath } = ctx(p);
    return q.sourceSnippet(rootPath, p.get('path'), Number(p.get('start') ?? 1), Number(p.get('end') ?? p.get('start') ?? 1), p.get('context') ? Number(p.get('context')) : 4);
  },
};

/** 需要写操作的接口：保存配置、大模型连通性自检 */
const POST_ROUTES = {
  '/api/config': (p, body) => {
    const next = saveConfig(body ?? {});
    store.resetConnections();
    return { ...next, savedAt: new Date().toISOString() };
  },
  '/api/index/run': (p, body) => indexer.start(body ?? {}),
  '/api/index/cancel': () => indexer.cancel(),
};

/** 读取并限制请求体大小（配置体量很小，1MB 足够） */
function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  if (!fs.existsSync(DIST)) {
    json(res, { error: 'dist/ 不存在，请先执行 npm run build，或用 npm run dev 走 Vite 开发服务器' }, 404);
    return;
  }
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  let file = path.join(DIST, rel);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html'); // SPA 回退
  try {
    const buf = fs.readFileSync(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Content-Length': buf.length });
    res.end(buf);
  } catch (err) {
    fail(res, err, 404);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    });
    res.end();
    return;
  }
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (!pathname.startsWith('/api/')) {
    if (SERVE_DIST) return serveStatic(req, res, pathname);
    return json(res, { error: '该服务仅提供 API。开发模式请访问 Vite 端口；静态托管请加 --serve-dist' }, 404);
  }

  const isPost = req.method === 'POST';
  const handler = isPost ? POST_ROUTES[pathname] : ROUTES[pathname];
  if (!handler) {
    const exists = isPost ? ROUTES[pathname] : POST_ROUTES[pathname];
    return json(res, { error: exists ? `${pathname} 不支持 ${req.method}` : `未知接口 ${pathname}` }, exists ? 405 : 404);
  }

  const t0 = Date.now();
  try {
    const body = isPost ? await readBody(req) : undefined;
    const data = await handler(url.searchParams, body);
    json(res, data);
    if (process.env.LOG !== '0') console.log(`[api] ${req.method} ${pathname} ${Date.now() - t0}ms`);
  } catch (err) {
    fail(res, err, err?.status ?? (isPost ? 400 : 500));
    console.error(`[api] ${req.method} ${pathname} ERR`, err?.message);
  }
});

server.listen(PORT, HOST, () => {
  const dir = store.cacheDir();
  const list = store.listProjects();
  const cfg = publicConfig();
  const shown = HOST === '0.0.0.0' ? '127.0.0.1' : HOST;
  console.log(`\n  Codebase Insight API  ->  http://${shown}:${PORT}${HOST === '0.0.0.0' ? `（监听全部网卡）` : ''}`);
  console.log(`  图数据库目录           ->  ${dir ?? '(未找到，可在配置页或 CBM_CACHE_DIR 指定)'}`);
  console.log(`  配置文件               ->  ${cfg.meta.configPath}${cfg.meta.exists ? '' : '（尚未创建）'}`);
  console.log(`  已索引项目 (${list.length})`);
  for (const p of list) console.log(`    · ${p.name}  ${p.nodes} 节点 / ${p.edges} 边  → ${p.rootPath}`);
  if (SERVE_DIST) console.log(`  静态托管               ->  ${DIST}`);
  if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
    console.log(`  注意                   ->  已对外开放，请确认网络边界；本服务无鉴权，只读接口也不宜裸奔在公网`);
  }
  console.log('');
});
