/**
 * 连接层：定位 codebase-memory-mcp 的缓存目录并打开相应的图数据库。
 *
 * codebase-memory-mcp 会在 CBM_CACHE_DIR 下为每个已索引项目落一个 SQLite 文件，
 * 文件名 = 项目名 + ".db"，项目名形如 "D-0.project-3.java-RuoYi"（由真实路径转义而来）。
 * 真实源码路径记录在库内 projects.root_path。
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { effective } from './config.mjs';

/**
 * 缓存目录解析优先级：
 *   1. 配置页填写的目录（存在即采纳，即使还没索引过项目）
 *   2. 环境变量 CBM_CACHE_DIR
 *   3. 常见默认目录（取第一个真正含 *.db 的）
 */
function cacheCandidates() {
  return [
    { dir: effective().cbm.cacheDir, strict: true },
    { dir: process.env.CBM_CACHE_DIR?.trim(), strict: false },
    { dir: 'D:/cbm-cache', strict: false },
    { dir: 'D:\\cbm-cache', strict: false },
    { dir: path.join(os.homedir(), '.cbm-cache'), strict: false },
    { dir: path.join(os.homedir(), 'AppData', 'Roaming', 'cbm-cache'), strict: false },
    { dir: path.join(os.homedir(), 'AppData', 'Local', 'cbm-cache'), strict: false },
  ].filter((c) => !!c.dir);
}

let _cacheDir = null;
let _cacheDirTried = false;

export function cacheDir() {
  if (_cacheDirTried) return _cacheDir;
  _cacheDirTried = true;
  for (const { dir, strict } of cacheCandidates()) {
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      if (strict) {
        _cacheDir = dir;
        return _cacheDir;
      }
      if (fs.readdirSync(dir).some((f) => f.endsWith('.db'))) {
        _cacheDir = dir;
        return _cacheDir;
      }
    } catch {
      /* 探测下一个候选 */
    }
  }
  _cacheDir = null;
  return null;
}

/** 配置变更后调用：关闭全部连接，下次访问按新目录重新解析 */
export function resetConnections() {
  for (const h of OPEN.values()) {
    try {
      h.db.close();
    } catch {
      /* ignore */
    }
  }
  OPEN.clear();
  _cacheDir = null;
  _cacheDirTried = false;
  _listCache = null;
}

/** 项目名 -> { db, statements } 的惰性连接池 */
const OPEN = new Map();

export function openDb(projectName) {
  if (OPEN.has(projectName)) return OPEN.get(projectName);
  const dir = cacheDir();
  if (!dir) throw new Error('未找到 codebase-memory 缓存目录（可用 CBM_CACHE_DIR 指定）');
  const file = path.join(dir, `${projectName}.db`);
  if (!fs.existsSync(file)) throw new Error(`项目数据库不存在：${file}`);

  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch {
    db = new DatabaseSync(file);
  }

  const planCache = new Map();
  const handle = {
    name: projectName,
    file,
    db,
    /** 预编译语句缓存 */
    q(sql) {
      let stmt = planCache.get(sql);
      if (!stmt) {
        stmt = db.prepare(sql);
        planCache.set(sql, stmt);
      }
      return stmt;
    },
    /** 查询并返回对象数组 */
    all(sql, params = []) {
      return this.q(sql).all(...params);
    },
    /** 查询并返回单行 */
    one(sql, params = []) {
      return this.q(sql).get(...params) ?? null;
    },
    close() {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      OPEN.delete(projectName);
    },
  };
  OPEN.set(projectName, handle);
  return handle;
}

/**
 * 列出全部可浏览项目（跳过 ::missed 这类伪项目）。
 *
 * 注意这里的 COUNT(*) 在百万节点库上是全表扫描（边表上千万行时单次数百毫秒到数秒），
 * 而 ctx() 每个请求都会调它，所以必须缓存；索引完成后由 resetConnections 失效。
 */
const LIST_TTL_MS = 15000;
let _listCache = null;

export function invalidateProjectList() {
  _listCache = null;
}

export function listProjects() {
  const now = Date.now();
  if (_listCache && now - _listCache.at < LIST_TTL_MS) return _listCache.v;

  const dir = cacheDir();
  if (!dir) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.db') || f.startsWith('_')) continue;
    const name = f.slice(0, -3);
    try {
      const h = openDb(name);
      const rows = h.all('SELECT name, root_path, indexed_at FROM projects');
      const real = rows.find((r) => !r.name.includes('::')) || rows[0];
      if (!real) continue;
      const nodeCount = h.one('SELECT COUNT(*) AS n FROM nodes')?.n ?? 0;
      const edgeCount = h.one('SELECT COUNT(*) AS n FROM edges')?.n ?? 0;
      const stat = fs.statSync(h.file);
      out.push({
        name,
        rootPath: real.root_path,
        indexedAt: real.indexed_at,
        dbPath: h.file,
        dbBytes: stat.size,
        nodes: nodeCount,
        edges: edgeCount,
        rootExists: !!real.root_path && fs.existsSync(real.root_path),
      });
    } catch {
      /* 跳过无法打开的库 */
    }
  }
  out.sort((a, b) => b.nodes - a.nodes);
  _listCache = { v: out, at: now };
  return out;
}

/** 安全解析节点的 properties JSON */
export function props(row) {
  if (!row) return {};
  const raw = row.properties;
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export { path as nodePath };
