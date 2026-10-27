/**
 * 分析缓存层：把节点 properties 里的指标「解析一次、物化成带索引的副库」。
 *
 * 为什么需要它（百万节点实测）：
 *   - 方法节点 properties 是 JSON 文本，任何聚合都必须逐行解析；
 *   - 实测 SQLite 的 json_extract 并不比 JS 的 JSON.parse 快（560k 行固定 2–7s），
 *     且多个字段要多次提取、每次重复解析，13 个字段会放大到十几秒；
 *   - 于是「每个接口各解析一遍」在百万节点下必然十几秒起。
 *
 * 做法：一次扫描（SELECT * + JSON.parse，实测约 3.3s）把需要的指标落进副库的
 * method_stats 表（纯数值列 + 索引），之后分位数、直方图、分页、按模块聚合
 * 全部走 SQL 索引，毫秒级。副库按「主库文件 mtime+size」做版本，索引重建即失效。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { props } from './db.mjs';

const SIDE_DIR = path.join(os.tmpdir(), 'cbm-analytics');

/** 主库版本：换库或重新索引后副库自动重建 */
export function dbVersion(h) {
  try {
    const st = fs.statSync(h.file);
    return `${Math.round(st.mtimeMs)}_${st.size}`;
  } catch {
    return 'unknown';
  }
}

const moduleOf = (f) => {
  if (!f) return '(root)';
  const segs = f.split('/');
  return segs.length > 1 ? segs[0] : '(root)';
};

const packageOf = (f) => {
  if (!f) return '(root)';
  const segs = f.split('/');
  const i = segs.indexOf('java');
  if (i >= 0 && i + 2 < segs.length) return segs.slice(i + 1, -1).join('.');
  return segs.slice(0, -1).join('/') || '(root)';
};

const SCHEMA = `
PRAGMA journal_mode = OFF;
PRAGMA synchronous = OFF;
CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE counts (kind TEXT NOT NULL, name TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (kind, name));
CREATE TABLE method_stats (
  id INTEGER PRIMARY KEY, label TEXT, name TEXT, qn TEXT, file TEXT,
  line INTEGER, end_line INTEGER,
  complexity INTEGER, cognitive INTEGER, lines INTEGER,
  loop_depth INTEGER, loop_count INTEGER, param_count INTEGER, max_access INTEGER,
  is_entry INTEGER, is_test INTEGER, importance REAL,
  parent_class TEXT, signature TEXT, doc TEXT, fp TEXT,
  module TEXT, pkg TEXT
);
`;

/*
 * 索引只留查询真正用到的：建索引在百万级方法数下要十几秒，每多一个都是冷启动成本。
 * 排序口径用复合索引覆盖，其首列同时服务对应的单列过滤与 GROUP BY。
 */
const INDEXES = `
CREATE INDEX i_fp ON method_stats(fp);
CREATE INDEX i_file ON method_stats(file);
CREATE INDEX i_sort_cx ON method_stats(complexity DESC, cognitive DESC, id);
CREATE INDEX i_sort_cog ON method_stats(cognitive DESC, complexity DESC, id);
CREATE INDEX i_sort_lines ON method_stats(lines DESC, complexity DESC, id);
CREATE INDEX i_sort_loop ON method_stats(loop_depth DESC, complexity DESC, id);
CREATE INDEX i_sort_module ON method_stats(module, complexity DESC, id);
`;

/** 构建/读取耗时探针：PERF_LOG=1 时输出到 stderr */
const perfLog = (...a) => {
  if (process.env.PERF_LOG === '1') console.error('[perf]', ...a);
};

/** 已打开的副库句柄：project -> { version, db, fileName } */
const OPEN = new Map();

/** 进程内指标缓存（避免同一请求内重复取） */
let _pending = null;

function buildSidecar(h, dest, version) {
  if (fs.existsSync(dest)) fs.rmSync(dest, { force: true });
  const db = new DatabaseSync(dest);
  db.exec(SCHEMA);

  const src = h.all(`SELECT id, label, name, qualified_name, file_path, start_line, end_line, properties
                     FROM nodes WHERE label IN ('Method','Function')`);
  const ins = db.prepare(
    `INSERT OR REPLACE INTO method_stats
     (id,label,name,qn,file,line,end_line,complexity,cognitive,lines,loop_depth,loop_count,param_count,
      max_access,is_entry,is_test,importance,parent_class,signature,doc,fp,module,pkg)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  db.exec('BEGIN');
  for (const r of src) {
    const d = props(r);
    const file = r.file_path || '';
    const start = r.start_line || 0;
    const end = r.end_line || 0;
    ins.run(
      r.id,
      r.label,
      r.name,
      r.qualified_name || '',
      file,
      start,
      end,
      Number(d.complexity) || 0,
      Number(d.cognitive) || 0,
      Number.isFinite(Number(d.lines)) ? Number(d.lines) : Math.max(0, end - start + 1),
      Number(d.loop_depth) || 0,
      Number(d.loop_count) || 0,
      Number(d.param_count) || 0,
      Number(d.max_access_depth) || 0,
      d.is_entry_point ? 1 : 0,
      d.is_test ? 1 : 0,
      Number(d.importance) || 0,
      d.parent_class ? String(d.parent_class).split('.').pop() : '',
      d.signature != null ? String(d.signature) : '',
      d.docstring != null ? String(d.docstring) : '',
      d.fp != null ? String(d.fp) : null,
      moduleOf(file),
      packageOf(file)
    );
  }
  db.exec('COMMIT');
  db.exec(INDEXES);

  /*
   * 节点类型 / 边类型计数也物化进副库。
   * 边类型计数要在上千万行的边表上做索引扫描（实测冷缓存下数秒），
   * 而它每次重启后都会被总览页问一遍；放进副库后只有建库那一次。
   */
  db.exec('BEGIN');
  const insCount = db.prepare('INSERT OR REPLACE INTO counts VALUES (?,?,?)');
  for (const r of h.all('SELECT label AS name, COUNT(*) AS n FROM nodes WHERE project = ? GROUP BY label', [h.name])) {
    insCount.run('node', r.name, r.n);
  }
  for (const r of h.all('SELECT type AS name, COUNT(*) AS n FROM edges WHERE project = ? GROUP BY type', [h.name])) {
    insCount.run('edge', r.name, r.n);
  }
  db.exec('COMMIT');

  /*
   * 不做 ANALYZE：实测在 56 万行 + 7 个索引上要 1.9s，
   * 而这里全是简单索引查询，SQLite 的默认统计足以选对计划。
   */
  db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run('version', version);
  db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run('rows', String(src.length));
  return db;
}

/**
 * 取得（必要时构建）该项目的指标副库。
 * 返回到 method_stats 的只读查询封装；构建失败时返回 null，调用方回退到实时解析。
 */
export function analytics(h) {
  const version = dbVersion(h);
  const cached = OPEN.get(h.name);
  if (cached && cached.version === version) return cached;

  fs.mkdirSync(SIDE_DIR, { recursive: true });
  const safe = h.name.replace(/[^\w.-]/g, '_');
  // 文件名里带版本：换版本就是换文件，绝不会读到旧数据
  const file = path.join(SIDE_DIR, `${safe}__${version.replace(/[^\d]/g, '_')}.db`);

  let db;
  const t0 = Date.now();
  let built = false;
  try {
    if (fs.existsSync(file)) {
      db = new DatabaseSync(file, { readOnly: true });
      const v = db.prepare('SELECT v FROM meta WHERE k=?').get('version')?.v;
      if (v !== version) {
        db.close();
        db = buildSidecar(h, file, version);
        built = true;
      }
    } else {
      db = buildSidecar(h, file, version);
      built = true;
    }
  } catch (err) {
    // 副库不可用（只读目录、磁盘满等）——退化为实时解析，功能不受影响
    try {
      db?.close();
    } catch {
      /* ignore */
    }
    const fallback = { version, db: null, file, buildMs: Date.now() - t0, error: String(err?.message ?? err) };
    OPEN.set(h.name, fallback);
    return fallback;
  }

  // 清掉同项目的旧版本文件，避免临时目录膨胀
  try {
    for (const f of fs.readdirSync(SIDE_DIR)) {
      if (f.startsWith(`${safe}__`) && path.join(SIDE_DIR, f) !== file) fs.rmSync(path.join(SIDE_DIR, f), { force: true });
    }
  } catch {
    /* ignore */
  }

  const entry = {
    version,
    db,
    file,
    buildMs: Date.now() - t0,
    built,
    all: (sql, params = []) => db.prepare(sql).all(...params),
    one: (sql, params = []) => db.prepare(sql).get(...params) ?? null,
  };
  perfLog(built ? 'sidecar built' : 'sidecar reused', h.name, `${entry.buildMs}ms`, path.basename(file));
  OPEN.set(h.name, entry);
  return entry;
}

/** 关闭全部副库（配置切换/进程退出用） */
export function closeAnalytics() {
  for (const [, v] of OPEN) {
    try {
      v.db?.close();
    } catch {
      /* ignore */
    }
  }
  OPEN.clear();
  _pending = null;
}

/* ------------------------------------------------------------ 结果级缓存 */

/**
 * 接口级结果缓存。
 *
 * 百万节点下即使走副库，冷启动仍要付一次构建价；而 UI 会在视图间反复切换。
 * 这里按「库版本 + 接口 + 参数」缓存整个响应体，重新索引（mtime 变）自动整体失效。
 */
const RESULT_TTL_MS = 10 * 60 * 1000;
const RESULT_MAX = 64;
const RESULTS = new Map();

export function cached(h, key, fn) {
  const k = `${h.name}\u0000${dbVersion(h)}\u0000${key}`;
  const hit = RESULTS.get(k);
  const now = Date.now();
  if (hit && now - hit.at < RESULT_TTL_MS) {
    perfLog('cache HIT ', key.slice(0, 90));
    return hit.v;
  }
  const v = fn();
  perfLog('cache MISS', key.slice(0, 90), `${Date.now() - now}ms`);
  RESULTS.set(k, { v, at: now });
  if (RESULTS.size > RESULT_MAX) {
    // 简单淘汰：按插入顺序丢最早的一半
    const keys = [...RESULTS.keys()].slice(0, Math.ceil(RESULT_MAX / 2));
    for (const kk of keys) RESULTS.delete(kk);
  }
  return v;
}

export function cacheStats() {
  return { entries: RESULTS.size, sidecars: [...OPEN.keys()] };
}
