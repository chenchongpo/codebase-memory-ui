/**
 * 查询层：把 codebase-memory 的图数据聚合成各视图所需的指标。
 * 所有函数只读、返回可 JSON 序列化的普通对象。
 */
import fs from 'node:fs';
import path from 'node:path';
import { props } from './db.mjs';
import { rules } from './config.mjs';
import { analytics, cached } from './analytics.mjs';

const bucketOf = (v) => (v <= 5 ? '1-5' : v <= 10 ? '6-10' : v <= 20 ? '11-20' : v <= 40 ? '21-40' : '40+');

/**
 * 高复杂度阈值（单一来源）。
 *
 * 全工程只有这一个定义：总览的「高复杂度函数」、分层图的「超 10 的」、指标说明页
 * 都引用它。此前总览用的是「不在 1–5 档」（即 > 5）、分层图用的是 > 10，
 * 同一个概念两个阈值，容易让人以为是 bug，已统一为 > 10。
 * 与分档边界对齐：> 10 即从「11–20」档开始算高复杂度。
 */
const HOT_COMPLEXITY = 10;
const isHot = (cx) => cx > HOT_COMPLEXITY;

export function moduleOf(filePath) {
  if (!filePath) return '(root)';
  const segs = filePath.split('/');
  return segs.length > 1 ? segs[0] : '(root)';
}

export function packageOf(filePath) {
  if (!filePath) return '(root)';
  const segs = filePath.split('/');
  const i = segs.indexOf('java');
  if (i >= 0 && i + 2 < segs.length) return segs.slice(i + 1, -1).join('.');
  return segs.slice(0, -1).join('/') || '(root)';
}

/**
 * 统一分页切片（明细表通用）。
 * all=1 用于导出，最多取 5000 条；页码越界自动收敛到合法区间。
 */
function pageOf(rows, opts = {}, defaultSize = 50) {
  const total = rows.length;
  const all = opts.all === true || opts.all === 1 || opts.all === '1';
  const pageSize = all ? Math.min(total, 5000) : Math.min(Math.max(Math.round(Number(opts.pageSize) || defaultSize), 10), 500);
  const totalPages = all ? 1 : Math.max(1, Math.ceil(total / pageSize));
  const page = all ? 1 : Math.min(Math.max(Math.round(Number(opts.page) || 1), 1), totalPages);
  const from = all ? 0 : (page - 1) * pageSize;
  const slice = all ? rows.slice(0, Math.min(total, 5000)) : rows.slice(from, from + pageSize);
  return {
    rows: slice,
    filtered: total,
    returned: slice.length,
    truncated: all && total > slice.length,
    page,
    pageSize,
    totalPages,
    from: slice.length ? from + 1 : 0,
    to: from + slice.length,
  };
}

/* ------------------------------------------------------------ 调用边的统一口径 */

/**
 * 「可信调用边」口径，所有吃 CALLS 的视图统一走这里。
 *
 * 索引器（codebase-memory-mcp）在类型解析失败时会退化到名字匹配，产生两类脏边：
 *   ① 目标落到 Field / Variable / Route / Class 上（实测 RuoYi 171 条，形如 `-> [Variable] open`）；
 *   ② 调用方根本不是可调用节点（实测 RuoYi 249 条从 Module / File 出发的「调用」）。
 * 两端都必须是 Method / Function 才算一次真实调用，其余一律剔除。
 *
 * 置信度不在这里砍，也不在任何地方砍：数值与对错并不对齐（见 resolveVia 注释），
 * 不可信的边会原样保留并带上溯源分级，由链路视图标红交给用户核对。
 */
const CALLABLE = `('Method','Function')`;

/**
 * 按 source 批量取 CALLS 邻居（走 idx_edges_source_type，单点 1ms、200 个 id 约 10ms）。
 *
 * @param ids 调用方 id 列表
 * @param dir 'out' = 沿调用方向找被调方；'in' = 反向找调用方
 * @param project 项目名，必须给：库内索引以 project 打头，漏掉就退化为全表扫描
 */
function callNeighbors(h, ids, dir, project) {
  const out = new Map();
  if (!ids.length) return out;
  const col = dir === 'out' ? 'source_id' : 'target_id';
  const other = dir === 'out' ? 'target_id' : 'source_id';
  // 分批，避免 SQL 变量过多
  const CHUNK = 400;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const batch = ids.slice(i, i + CHUNK);
    const ph = batch.map(() => '?').join(',');
    const rows = h.all(
      `SELECT e.${col} AS a, e.${other} AS b, e.properties AS p
       FROM edges e
       JOIN nodes tn ON tn.id = e.${other}
       JOIN nodes ts ON ts.id = e.${col}
       WHERE e.project = ? AND e.type = 'CALLS' AND e.${col} IN (${ph})
         AND tn.label IN ${CALLABLE} AND ts.label IN ${CALLABLE}`,
      [project, ...batch]
    );
    for (const r of rows) {
      if (!out.has(r.a)) out.set(r.a, []);
      let ep = {};
      try {
        ep = JSON.parse(r.p || '{}');
      } catch {
        /* 属性损坏按无行号处理 */
      }
      out.get(r.a).push({ id: r.b, line: ep.line ?? 0, via: resolveVia(ep) });
    }
  }
  return out;
}

/**
 * 解析溯源分级 —— 链路视图的核心口径。
 *
 * 这里刻意不看 `confidence` 那个数值。实测结论：数值与对错并不对齐
 * （`unique_name` 候选唯一却只给 0.38，多数其实是对的；`suffix_match` 给 0.55
 * 却常常把 `Map.put` / `AtomicInteger.set` 这类 JDK 调用错接到项目内同名方法上）。
 * 真正决定可信与否的是「怎么解出来的」，因此按 strategy 分三档：
 *
 *   exact    有类型依据：LSP 类型派发 / 字段类型提示 / 限定名 / 同模块 / import 映射
 *   inferred 靠「项目内唯一同名」推断：无类型依据，但全项目只有这一个同名方法
 *   suspect  靠后缀匹配从多个候选里挑了一个，或根本没有解析记录 —— 必须人工核对
 *
 * 不准确的不隐藏、不过滤，原样保留并在界面上标红，交由用户核对。
 */
const EXACT_STRATEGIES = new Set(['field_type_hint', 'qualified_suffix', 'same_module', 'import_map']);

/** 常见 JDK / 三方库方法名：命中即高度怀疑是外部调用被错接到项目内同名方法 */
const LIB_METHOD_NAMES = new Set([
  'put', 'get', 'set', 'add', 'addAll', 'remove', 'removeAll', 'size', 'isEmpty', 'contains',
  'containsKey', 'containsValue', 'clear', 'equals', 'hashCode', 'toString', 'getClass',
  'getName', 'getType', 'getKey', 'getValue', 'valueOf', 'trim', 'split', 'substring', 'length',
  'charAt', 'format', 'join', 'sort', 'copy', 'append', 'delete', 'insert', 'close', 'flush',
  'iterator', 'next', 'hasNext', 'getBytes', 'parse', 'compareTo', 'increment', 'decrement',
  'getAndIncrement', 'getAndSet', 'wait', 'notify', 'notifyAll', 'stream', 'forEach', 'filter',
  'map', 'collect', 'of', 'asList', 'toArray', 'keySet', 'values', 'entrySet', 'matches', 'replace',
  // 日志 / 反射 / Servlet / IO：Spring 工程里错接率最高的几个来源
  'error', 'warn', 'info', 'debug', 'trace', 'printStackTrace', 'getMessage', 'getCause',
  'getAttribute', 'setAttribute', 'getParameter', 'getSession', 'getRequestURI', 'sendRedirect',
  'println', 'printf', 'write', 'read', 'newInstance', 'invoke', 'getAnnotation',
]);

function resolveVia(ep) {
  const strategy = typeof ep?.strategy === 'string' ? ep.strategy : '';
  const callee = typeof ep?.callee === 'string' ? ep.callee : '';
  const candidates = Number(ep?.candidates) || 0;
  const leaf = callee.split('.').pop();
  const external = !!leaf && LIB_METHOD_NAMES.has(leaf);
  const base = { strategy: strategy || '(未记录)', callee: callee || '', candidates, external };
  if (strategy.startsWith('lsp_') || EXACT_STRATEGIES.has(strategy)) return { kind: 'exact', ...base };
  if (strategy === 'unique_name') return { kind: 'inferred', ...base };
  return { kind: 'suspect', ...base };
}

/** 载入项目内全部“可度量节点”（方法/函数），解析 properties */
/**
 * 载入项目内全部“可度量节点”（方法/函数），解析 properties。
 *
 * 走 analytics 副库：properties 里的指标在副库里已是普通数值列，
 * 不用再对几十万行做 JSON.parse（百万节点实测 3.3s → 数百毫秒）。
 * 副库不可用时回退到原始解析路径，功能不受影响。
 */
function loadCodeNodes(h, labels = ['Method', 'Function']) {
  const side = analytics(h);
  const rowToCode = (r) => ({
    id: r.id,
    label: r.label,
    name: r.name,
    qn: r.qn,
    file: r.file || '',
    line: r.line || 0,
    endLine: r.end_line || 0,
    module: r.module,
    pkg: r.pkg,
    complexity: r.complexity,
    cognitive: r.cognitive,
    lines: r.lines,
    loopDepth: r.loop_depth,
    loopCount: r.loop_count,
    paramCount: r.param_count,
    maxAccessDepth: r.max_access,
    isEntry: !!r.is_entry,
    isTest: !!r.is_test,
    isExported: false,
    importance: r.importance,
    parentClass: r.parent_class || '',
    signature: r.signature || '',
    returnType: '',
    doc: r.doc || '',
    routePath: null,
    routeMethod: null,
    fp: r.fp,
    raw: {},
  });

  if (side.db) {
    return side
      .all(
        `SELECT id,label,name,qn,file,line,end_line,complexity,cognitive,lines,loop_depth,loop_count,
                param_count,max_access,is_entry,is_test,importance,parent_class,signature,doc,fp,module,pkg
         FROM method_stats
         WHERE label IN (${labels.map(() => '?').join(',')})`,
        labels
      )
      .map(rowToCode);
  }

  const ph = labels.map(() => '?').join(',');
  const rows = h.all(
    `SELECT id, label, name, qualified_name, file_path, start_line, end_line, properties
     FROM nodes WHERE label IN (${ph})`,
    labels
  );
  return rows.map((r) => {
    const d = props(r);
    return {
      id: r.id,
      label: r.label,
      name: r.name,
      qn: r.qualified_name,
      file: r.file_path || '',
      line: r.start_line || 0,
      endLine: r.end_line || 0,
      module: moduleOf(r.file_path),
      pkg: packageOf(r.file_path),
      complexity: d.complexity ?? 0,
      cognitive: d.cognitive ?? 0,
      lines: d.lines ?? Math.max(0, (r.end_line || 0) - (r.start_line || 0) + 1),
      loopDepth: d.loop_depth ?? 0,
      loopCount: d.loop_count ?? 0,
      paramCount: d.param_count ?? 0,
      maxAccessDepth: d.max_access_depth ?? 0,
      isEntry: !!d.is_entry_point,
      isTest: !!d.is_test,
      isExported: !!d.is_exported,
      importance: d.importance ?? 0,
      parentClass: d.parent_class ? String(d.parent_class).split('.').pop() : '',
      signature: d.signature ?? '',
      returnType: d.return_type ?? '',
      doc: d.docstring ?? '',
      routePath: d.route_path ?? null,
      routeMethod: d.route_method ?? null,
      fp: d.fp ?? null,
      raw: d,
    };
  });
}

/* ------------------------------------------------------------------ 总览 */

export function overview(h, rootPath) {
  return cached(h, 'overview', () => overviewUncached(h, rootPath));
}

function overviewUncached(h, rootPath) {
  // 必须带 project：库内索引都是 (project, label) / (project, type) 打头，
  // 不带 project 条件时索引退化为全表扫描（百万节点实测边类型计数 10.4s → 1.6s）
  const side = analytics(h);
  // 类型计数优先读副库（边类型计数在主库上要扫上千万行索引，实测冷缓存数秒）
  let labelRows;
  let edgeRows;
  if (side.db) {
    labelRows = side.all(`SELECT name AS label, n FROM counts WHERE kind='node' ORDER BY n DESC`);
    edgeRows = side.all(`SELECT name AS type, n FROM counts WHERE kind='edge' ORDER BY n DESC`);
  }
  if (!labelRows?.length) labelRows = h.all('SELECT label, COUNT(*) AS n FROM nodes WHERE project = ? GROUP BY label ORDER BY n DESC', [h.name]);
  if (!edgeRows?.length) edgeRows = h.all(`SELECT type, COUNT(*) AS n FROM edges WHERE project = ? GROUP BY type ORDER BY n DESC`, [h.name]);

  const toCountMap = (rows, key) => rows.reduce((m, r) => ((m[r[key]] = r.n), m), {});
  const labelMap = toCountMap(labelRows, 'label');

  /*
   * 指标全部在副库里用 SQL 聚合。
   * 旧实现读回 56 万行装成 JS 对象再算，单是读回就 7s；这里换成几个索引聚合。
   */
  const coverage = h.all('SELECT kind, COUNT(*) AS n FROM index_coverage GROUP BY kind');
  const totalEdges = edgeRows.reduce((a, r) => a + r.n, 0);
  const totalNodes = labelRows.reduce((a, r) => a + r.n, 0);

  const projectRow = h.one('SELECT name, root_path, indexed_at FROM projects WHERE name = ?', [h.name]);
  const branch = h.one(`SELECT properties FROM nodes WHERE project = ? AND label='Branch' LIMIT 1`, [h.name]);
  const bp = props(branch);
  const summaryRow = h.one('SELECT summary, updated_at FROM project_summaries WHERE project = ?', [h.name]);

  let methodAgg;
  let metrics;
  let modules;
  let topMethods;

  if (side.db) {
    methodAgg = side.one(
      `SELECT COUNT(*) n, AVG(complexity) avgCx, MAX(complexity) maxCx, AVG(lines) avgLines, AVG(cognitive) avgCog,
              SUM(lines) loc, SUM(is_entry) entry, SUM(is_test) tests,
              SUM(CASE WHEN complexity > ${HOT_COMPLEXITY} THEN 1 ELSE 0 END) hot
       FROM method_stats`
    );
    const total = methodAgg?.n ?? 0;
    const at = (p) => {
      if (!total) return 0;
      const off = Math.min(total - 1, Math.floor(total * p));
      return side.one('SELECT complexity c FROM method_stats ORDER BY complexity LIMIT 1 OFFSET ?', [off])?.c ?? 0;
    };
    metrics = {
      avgComplexity: +(methodAgg?.avgCx ?? 0).toFixed(2),
      maxComplexity: methodAgg?.maxCx ?? 0,
      p50: at(0.5),
      p90: at(0.9),
      p99: at(0.99),
      avgLines: +(methodAgg?.avgLines ?? 0).toFixed(1),
      avgCognitive: +(methodAgg?.avgCog ?? 0).toFixed(2),
      entryPoints: methodAgg?.entry ?? 0,
      testMethods: methodAgg?.tests ?? 0,
      hotSpots: methodAgg?.hot ?? 0,
    };
    modules = side
      .all(
        `SELECT module name, COUNT(*) count, AVG(complexity) avgCx, MAX(complexity) maxCx,
                SUM(lines) lines, COUNT(DISTINCT file) files
         FROM method_stats GROUP BY module ORDER BY count DESC`
      )
      .map((r) => ({ ...r, avgCx: +r.avgCx.toFixed(2) }));
    topMethods = side
      .all(
        `SELECT name, parent_class cls, module, complexity, lines, cognitive cog, file, line
         FROM method_stats ORDER BY complexity DESC, lines DESC, id ASC LIMIT 8`
      );
  } else {
    const codes = loadCodeNodes(h);
    const cx = codes.map((c) => c.complexity).sort((a, b) => a - b);
    const sum = (a) => a.reduce((x, y) => x + y, 0);
    const pct = (p) => (cx.length ? cx[Math.min(cx.length - 1, Math.floor(cx.length * p))] : 0);
    const byModule = new Map();
    for (const c of codes) {
      if (!byModule.has(c.module)) byModule.set(c.module, { name: c.module, count: 0, cx: 0, maxCx: 0, lines: 0, files: new Set() });
      const m = byModule.get(c.module);
      m.count += 1;
      m.cx += c.complexity;
      m.lines += c.lines;
      m.maxCx = Math.max(m.maxCx, c.complexity);
      if (c.file) m.files.add(c.file);
    }
    methodAgg = { n: codes.length, loc: sum(codes.map((c) => c.lines)) };
    metrics = {
      avgComplexity: codes.length ? +(sum(codes.map((c) => c.complexity)) / codes.length).toFixed(2) : 0,
      maxComplexity: cx.length ? cx[cx.length - 1] : 0,
      p50: pct(0.5),
      p90: pct(0.9),
      p99: pct(0.99),
      avgLines: codes.length ? +(sum(codes.map((c) => c.lines)) / codes.length).toFixed(1) : 0,
      avgCognitive: codes.length ? +(sum(codes.map((c) => c.cognitive)) / codes.length).toFixed(2) : 0,
      entryPoints: codes.filter((c) => c.isEntry).length,
      testMethods: codes.filter((c) => c.isTest).length,
      hotSpots: codes.filter((c) => isHot(c.complexity)).length,
    };
    modules = [...byModule.values()]
      .map((m) => ({ name: m.name, count: m.count, avgCx: +(m.cx / m.count).toFixed(2), maxCx: m.maxCx, lines: m.lines, files: m.files.size }))
      .sort((a, b) => b.count - a.count);
    topMethods = [...codes]
      .sort((a, b) => b.complexity - a.complexity || b.lines - a.lines || a.id - b.id)
      .slice(0, 8)
      .map((c) => ({ name: c.name, cls: c.parentClass, module: c.module, complexity: c.complexity, lines: c.lines, cog: c.cognitive, file: c.file, line: c.line }));
  }

  return {
    project: {
      name: projectRow?.name ?? h.name,
      rootPath: projectRow?.root_path ?? rootPath ?? '',
      indexedAt: projectRow?.indexed_at ?? '',
      branch: bp.branch ?? '',
      headSha: (bp.head_sha ?? '').slice(0, 10),
      isGit: !!bp.is_git,
    },
    totals: {
      nodes: totalNodes,
      edges: totalEdges,
      files: labelMap.File ?? 0,
      folders: labelMap.Folder ?? 0,
      classes: (labelMap.Class ?? 0) + (labelMap.Interface ?? 0) + (labelMap.Enum ?? 0),
      methods: methodAgg?.n ?? 0,
      routes: labelMap.Route ?? 0,
      variables: (labelMap.Variable ?? 0) + (labelMap.Field ?? 0),
      indexedLoc: methodAgg?.loc ?? 0,
    },
    labels: labelRows,
    edgeTypes: edgeRows,
    metrics,
    modules,
    topMethods,
    coverage,
    summary: summaryRow?.summary ?? '',
  };
}

/* ------------------------------------------------------------ 复杂度分布 */

/** bucket → complexity 的 SQL 条件（与 bucketOf 的分档边界保持一致） */
const BUCKET_SQL = {
  '1-5': 'complexity <= 5',
  '6-10': 'complexity > 5 AND complexity <= 10',
  '11-20': 'complexity > 10 AND complexity <= 20',
  '21-40': 'complexity > 20 AND complexity <= 40',
  '40+': 'complexity > 40',
};

const BUCKET_CASE = `CASE WHEN complexity <= 5 THEN '1-5' WHEN complexity <= 10 THEN '6-10'
  WHEN complexity <= 20 THEN '11-20' WHEN complexity <= 40 THEN '21-40' ELSE '40+' END`;

/** 排序口径 → SQL ORDER BY（末位一律 id，保证翻页稳定） */
const CX_ORDER = {
  complexity: 'complexity DESC, cognitive DESC, id ASC',
  cognitive: 'cognitive DESC, complexity DESC, id ASC',
  lines: 'lines DESC, complexity DESC, id ASC',
  loop: 'loop_depth DESC, complexity DESC, id ASC',
  name: 'name ASC, id ASC',
  module: 'module ASC, complexity DESC, id ASC',
};

/**
 * 复杂度分布（SQL 版）。
 *
 * 旧实现把全部方法装进 JS 数组再排序、映射、切片；百万节点下光是
 * `matched.map()` 造 56 万个对象 + 排序就要十几秒。
 * 这里把分档、分位、模块聚合、排序分页、散点采样全部下推给副库索引。
 */
function complexitySql(side, opts = {}) {
  const wantModule = opts.module ?? '';
  const wantBucket = opts.bucket ?? '';
  const wantKind = opts.kind ?? '';
  const q = String(opts.q ?? '').trim().toLowerCase();
  const testFilter = opts.test ?? '';

  const where = [];
  const params = [];
  if (wantModule) {
    where.push('module = ?');
    params.push(wantModule);
  }
  if (wantBucket && BUCKET_SQL[wantBucket]) where.push(`(${BUCKET_SQL[wantBucket]})`);
  if (wantKind) {
    where.push('label = ?');
    params.push(wantKind);
  }
  if (testFilter === 'hide') where.push('is_test = 0');
  else if (testFilter === 'only') where.push('is_test = 1');
  if (q) {
    // 与旧实现等价：名称 / 所属类 / 文件 / 模块 / 包 / 签名 任一命中
    where.push('(lower(name) LIKE ? OR lower(parent_class) LIKE ? OR lower(file) LIKE ? OR lower(module) LIKE ? OR lower(pkg) LIKE ? OR lower(signature) LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like, like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = side.one('SELECT COUNT(*) n FROM method_stats')?.n ?? 0;

  const hist = { '1-5': 0, '6-10': 0, '11-20': 0, '21-40': 0, '40+': 0 };
  for (const r of side.all(`SELECT ${BUCKET_CASE} b, COUNT(*) n FROM method_stats GROUP BY b`)) hist[r.b] = r.n;

  const quantiles = (() => {
    const at = (p) => {
      if (!total) return 0;
      const off = Math.min(total - 1, Math.floor(total * p));
      const r = side.one('SELECT complexity c FROM method_stats ORDER BY complexity LIMIT 1 OFFSET ?', [off]);
      return r?.c ?? 0;
    };
    const maxRow = side.one('SELECT complexity c FROM method_stats ORDER BY complexity DESC LIMIT 1');
    return { p50: at(0.5), p75: at(0.75), p90: at(0.9), p95: at(0.95), p99: at(0.99), max: maxRow?.c ?? 0 };
  })();

  const modules = side
    .all(
      `SELECT module, COUNT(*) total, MAX(complexity) maxCx, SUM(lines) lines,
              SUM(CASE WHEN complexity <= 5 THEN 1 ELSE 0 END) b1,
              SUM(CASE WHEN complexity > 5 AND complexity <= 10 THEN 1 ELSE 0 END) b2,
              SUM(CASE WHEN complexity > 10 AND complexity <= 20 THEN 1 ELSE 0 END) b3,
              SUM(CASE WHEN complexity > 20 AND complexity <= 40 THEN 1 ELSE 0 END) b4,
              SUM(CASE WHEN complexity > 40 THEN 1 ELSE 0 END) b5
       FROM method_stats GROUP BY module ORDER BY total DESC`
    )
    .map((r) => ({
      module: r.module,
      total: r.total,
      maxCx: r.maxCx,
      lines: r.lines,
      buckets: { '1-5': r.b1, '6-10': r.b2, '11-20': r.b3, '21-40': r.b4, '40+': r.b5 },
    }));

  const slim = opts.slim === true || opts.slim === 1 || opts.slim === '1';
  if (slim) {
    return {
      hist,
      scatter: [],
      modules,
      quantiles,
      total,
      rows: [],
      filtered: 0,
      returned: 0,
      truncated: false,
      page: 1,
      pageSize: 0,
      totalPages: 1,
      from: 0,
      to: 0,
      applied: { module: wantModule, bucket: wantBucket, kind: wantKind, q, sort: opts.sort ?? 'complexity', test: testFilter, page: '1', pageSize: '0' },
    };
  }

  const filtered = side.one(`SELECT COUNT(*) n FROM method_stats ${whereSql}`, params)?.n ?? 0;
  const pageSize = Math.min(Math.max(Math.round(Number(opts.pageSize) || 50), 10), 500);
  const totalPages = Math.max(1, Math.ceil(filtered / pageSize));
  const page = Math.min(Math.max(Math.round(Number(opts.page) || 1), 1), totalPages);
  const orderBy = CX_ORDER[opts.sort ?? 'complexity'] ?? CX_ORDER.complexity;

  const rows = side
    .all(
      `SELECT id,label,name,parent_class,module,pkg,file,line,end_line,complexity,cognitive,lines,
              loop_depth,loop_count,param_count,is_entry,is_test,signature,doc
       FROM method_stats ${whereSql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize]
    )
    .map((r) => ({
      id: r.id,
      kind: r.label,
      name: r.name,
      cls: r.parent_class || '',
      module: r.module,
      pkg: r.pkg,
      file: r.file,
      line: r.line,
      endLine: r.end_line,
      complexity: r.complexity,
      cognitive: r.cognitive,
      lines: r.lines,
      loopDepth: r.loop_depth,
      loopCount: r.loop_count,
      paramCount: r.param_count,
      isEntry: !!r.is_entry,
      isTest: !!r.is_test,
      signature: r.signature,
      doc: (r.doc || '').replace(/\s+/g, ' ').slice(0, 200),
    }));

  // 散点只取固定上限（复杂度最高的一批），避免把几十万个点塞进响应
  const scatter = side
    .all(
      `SELECT lines x, complexity y, loop_depth z, cognitive cog, name n, parent_class c, file f, line l, is_test t
       FROM method_stats WHERE lines > 0 ORDER BY complexity DESC, id ASC LIMIT 3000`
    )
    .map((r) => ({ x: r.x, y: r.y, z: r.z, cog: r.cog, n: r.n, c: r.c || r.f, f: r.f, l: r.l, t: !!r.t }));

  return {
    hist,
    scatter,
    modules,
    quantiles,
    total,
    rows,
    filtered,
    returned: rows.length,
    truncated: false,
    page,
    pageSize,
    totalPages,
    from: rows.length ? (page - 1) * pageSize + 1 : 0,
    to: (page - 1) * pageSize + rows.length,
    applied: { module: wantModule, bucket: wantBucket, kind: wantKind, q, sort: opts.sort ?? 'complexity', test: testFilter, page: String(page), pageSize: String(pageSize) },
  };
}

export function complexity(h, opts = {}) {
  const side = analytics(h);
  // 副库可用时走 SQL 索引路径（百万节点毫秒级）；不可用则回退到下面的实时解析实现
  if (side.db) return cached(h, `complexity:${JSON.stringify(opts)}`, () => complexitySql(side, opts));

  const codes = loadCodeNodes(h);
  const hist = { '1-5': 0, '6-10': 0, '11-20': 0, '21-40': 0, '40+': 0 };
  for (const c of codes) hist[bucketOf(c.complexity)] += 1;

  const byModule = new Map();
  for (const c of codes) {
    if (!byModule.has(c.module)) byModule.set(c.module, { module: c.module, buckets: { '1-5': 0, '6-10': 0, '11-20': 0, '21-40': 0, '40+': 0 }, total: 0, maxCx: 0, lines: 0 });
    const m = byModule.get(c.module);
    m.buckets[bucketOf(c.complexity)] += 1;
    m.total += 1;
    m.lines += c.lines;
    m.maxCx = Math.max(m.maxCx, c.complexity);
  }

  const quantiles = (() => {
    const v = codes.map((c) => c.complexity).sort((a, b) => a - b);
    const at = (p) => (v.length ? v[Math.min(v.length - 1, Math.floor(v.length * p))] : 0);
    return { p50: at(0.5), p75: at(0.75), p90: at(0.9), p95: at(0.95), p99: at(0.99), max: v[v.length - 1] ?? 0 };
  })();

  /* ---------------- 明细：模块 / 复杂度档 / 关键字筛选 + 排序 + 分页 ---------------- */
  const wantModule = opts.module ?? '';
  const wantBucket = opts.bucket ?? '';
  const wantKind = opts.kind ?? '';
  const q = String(opts.q ?? '').trim().toLowerCase();
  const testFilter = opts.test ?? ''; // '' | 'hide' | 'only'

  const matched = codes.filter((c) => {
    if (wantModule && c.module !== wantModule) return false;
    if (wantBucket && bucketOf(c.complexity) !== wantBucket) return false;
    if (wantKind && c.label !== wantKind) return false;
    if (testFilter === 'hide' && c.isTest) return false;
    if (testFilter === 'only' && !c.isTest) return false;
    if (q) {
      const hay = `${c.name} ${c.parentClass} ${c.file} ${c.module} ${c.pkg} ${c.signature}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const cmp = {
    // 末位一律用 id 兜底，保证并列值顺序唯一确定，翻页不串行
    complexity: (a, b) => b.complexity - a.complexity || b.cognitive - a.cognitive || a.id - b.id,
    cognitive: (a, b) => b.cognitive - a.cognitive || b.complexity - a.complexity || a.id - b.id,
    lines: (a, b) => b.lines - a.lines || b.complexity - a.complexity || a.id - b.id,
    loop: (a, b) => b.loopDepth - a.loopDepth || b.complexity - a.complexity || a.id - b.id,
    name: (a, b) => String(a.name).localeCompare(String(b.name)) || a.id - b.id,
    module: (a, b) => a.module.localeCompare(b.module) || b.complexity - a.complexity || a.id - b.id,
  }[opts.sort ?? 'complexity'] ?? ((a, b) => b.complexity - a.complexity || a.id - b.id);
  matched.sort(cmp);

  const scatter = matched
    .filter((c) => c.lines > 0)
    .slice(0, 3000)
    .map((c) => ({ x: c.lines, y: c.complexity, z: c.loopDepth, cog: c.cognitive, n: c.name, c: c.parentClass || c.module, f: c.file, l: c.line, t: c.isTest }));

  // 总览页只要直方图与模块构成，不必背着 3000 个散点和整页明细
  const slim = opts.slim === true || opts.slim === 1 || opts.slim === '1';
  if (slim) {
    return {
      hist,
      scatter: [],
      modules: [...byModule.values()].sort((a, b) => b.total - a.total),
      quantiles,
      total: codes.length,
      rows: [],
      filtered: 0,
      returned: 0,
      truncated: false,
      page: 1,
      pageSize: 0,
      totalPages: 1,
      from: 0,
      to: 0,
      applied: { module: wantModule, bucket: wantBucket, kind: wantKind, q, sort: opts.sort ?? 'complexity', test: testFilter, page: '1', pageSize: '0' },
    };
  }

  const rows = matched.map((c) => ({
    id: c.id,
    kind: c.label,
    name: c.name,
    cls: c.parentClass,
    module: c.module,
    pkg: c.pkg,
    file: c.file,
    line: c.line,
    endLine: c.endLine,
    complexity: c.complexity,
    cognitive: c.cognitive,
    lines: c.lines,
    loopDepth: c.loopDepth,
    loopCount: c.loopCount,
    paramCount: c.paramCount,
    isEntry: c.isEntry,
    isTest: c.isTest,
    signature: c.signature,
    doc: (c.doc || '').replace(/\s+/g, ' ').slice(0, 200),
  }));

  const page = pageOf(rows, opts);

  return {
    hist,
    scatter,
    modules: [...byModule.values()].sort((a, b) => b.total - a.total),
    quantiles,
    total: codes.length,
    ...page,
    applied: { module: wantModule, bucket: wantBucket, kind: wantKind, q, sort: opts.sort ?? 'complexity', test: testFilter, page: String(page.page), pageSize: String(page.pageSize) },
  };
}

/* ------------------------------------------------------------ 重复实现热点 */

/**
 * 重复热点。
 *
 * 百万节点下的两个硬问题：
 *   1. 指纹组用 JS 遍历全部方法算（56 万行 JSON 解析），这里改成 SQL 分组；
 *   2. 旧实现把**全部**簇和全部成员的明细一次性返回（实测 30.9 MB），
 *      前端拿到就要崩，所以明细一律封顶，只返回摘要 + 头部若干组。
 */
const DUP_CLUSTER_LIMIT = 300;
const DUP_MEMBER_LIMIT = 20;
const DUP_FP_LIMIT = 300;

export function duplicates(h) {
  return cached(h, 'duplicates', () => duplicatesUncached(h));
}

function duplicatesUncached(h) {
  const rows = h.all(
    `SELECT e.source_id AS s, e.target_id AS t, e.properties AS p
     FROM edges e
     WHERE e.project = ? AND e.type = 'SIMILAR_TO'
     LIMIT 200000`,
    [h.name]
  );
  const parent = new Map();
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const union = (a, b) => {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  const info = new Map();
  const jac = new Map();
  for (const r of rows) {
    union(r.s, r.t);
    let j = 0;
    try {
      j = JSON.parse(r.p || '{}').jaccard ?? 0;
    } catch {
      /* ignore */
    }
    jac.set(r.s, Math.max(jac.get(r.s) ?? 0, j));
    jac.set(r.t, Math.max(jac.get(r.t) ?? 0, j));
    if (!info.has(r.s)) info.set(r.s, null);
    if (!info.has(r.t)) info.set(r.t, null);
  }

  /* 参与 SIMILAR_TO 的节点信息：从副库按批补齐（普通列，不解析 JSON） */
  const side = analytics(h);
  const ids = [...info.keys()];
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const batch = ids.slice(i, i + CHUNK);
    const ph = batch.map(() => '?').join(',');
    if (side.db) {
      for (const r of side.all(
        `SELECT id,name,label,file,line,lines,complexity,parent_class FROM method_stats WHERE id IN (${ph})`,
        batch
      )) {
        info.set(r.id, { id: r.id, name: r.name, label: r.label, file: r.file, line: r.line, lines: r.lines, complexity: r.complexity, parent_class: r.parent_class });
      }
    } else {
      for (const r of h.all(
        `SELECT id,label,name,file_path,start_line,properties FROM nodes WHERE project=? AND id IN (${ph})`,
        [h.name, ...batch]
      )) {
        const d = props(r);
        info.set(r.id, {
          id: r.id, name: r.name, label: r.label, file: r.file_path || '', line: r.start_line || 0,
          lines: d.lines ?? 0, complexity: d.complexity ?? 0, parent_class: d.parent_class,
        });
      }
    }
  }

  const groups = new Map();
  for (const id of info.keys()) {
    const r = find(id);
    if (!groups.has(r)) groups.set(r, []);
    const m = info.get(id);
    if (m) groups.get(r).push(m);
  }
  const allClusters = [...groups.values()]
    .filter((g) => g.length > 1)
    .map((g) => {
      const files = new Set(g.map((m) => m.file));
      return {
        size: g.length,
        jaccard: Math.max(...g.map((m) => jac.get(m.id) ?? 0)),
        crossFile: files.size > 1,
        loc: g.reduce((a, m) => a + (m.lines ?? 0), 0),
        members: g
          .map((m) => ({ id: m.id, name: m.name, label: m.label, file: m.file, line: m.line, lines: m.lines ?? 0, complexity: m.complexity ?? 0, cls: m.parent_class ? String(m.parent_class).split('.').pop() : '' }))
          .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
      };
    })
    .sort((a, b) => b.size - a.size || b.loc - a.loc);

  const clusterTotal = allClusters.length;
  const clusters = allClusters.slice(0, DUP_CLUSTER_LIMIT).map((c) => ({
    ...c,
    members: c.members.slice(0, DUP_MEMBER_LIMIT),
    membersTruncated: c.members.length > DUP_MEMBER_LIMIT,
  }));

  /*
   * 结构指纹分组：fp 完全一致 = 同一份实现被复制。
   * 分组本身交给 SQL（旧实现在 JS 里遍历 56 万行并 JSON.parse 每个）。
   */
  let fpTotal = 0;
  let fpReclaimLoc = 0;
  let fingerprints = [];
  if (side.db) {
    fpTotal = side.one(`SELECT COUNT(*) n FROM (SELECT fp FROM method_stats WHERE fp IS NOT NULL GROUP BY fp HAVING COUNT(*) > 1)`)?.n ?? 0;
    fpReclaimLoc =
      side.one(
        `SELECT COALESCE(SUM(loc - mx),0) v FROM (
           SELECT SUM(lines) loc, MAX(lines) mx FROM method_stats WHERE fp IS NOT NULL GROUP BY fp HAVING COUNT(*) > 1)`
      )?.v ?? 0;
    const topFps = side.all(
      `SELECT fp, COUNT(*) size, SUM(lines) loc FROM method_stats
       WHERE fp IS NOT NULL GROUP BY fp HAVING COUNT(*) > 1
       ORDER BY SUM(lines) DESC LIMIT ?`,
      [DUP_FP_LIMIT]
    );
    fingerprints = topFps.map((g) => {
      const members = side.all(
        `SELECT id,name,file,line,lines,complexity FROM method_stats WHERE fp = ? ORDER BY file, line LIMIT ?`,
        [g.fp, DUP_MEMBER_LIMIT]
      );
      return { fp: g.fp, size: g.size, loc: g.loc, members, membersTruncated: g.size > members.length };
    });
  } else {
    const fpGroups = new Map();
    for (const r of h.all(`SELECT id, name, file_path, start_line, properties FROM nodes WHERE project=? AND label IN ('Method','Function')`, [h.name])) {
      const d = props(r);
      if (!d.fp) continue;
      if (!fpGroups.has(d.fp)) fpGroups.set(d.fp, []);
      fpGroups.get(d.fp).push({ id: r.id, name: r.name, file: r.file_path || '', line: r.start_line || 0, lines: d.lines ?? 0, complexity: d.complexity ?? 0 });
    }
    const all = [...fpGroups.entries()]
      .filter(([, g]) => g.length > 1)
      .map(([fp, g]) => ({ fp, size: g.length, loc: g.reduce((a, m) => a + m.lines, 0), members: g.sort((a, b) => a.file.localeCompare(b.file)) }))
      .sort((a, b) => b.loc - a.loc);
    fpTotal = all.length;
    fpReclaimLoc = all.reduce((a, g) => a + g.loc - (g.members[0]?.lines ?? 0), 0);
    fingerprints = all.slice(0, DUP_FP_LIMIT);
  }

  return {
    clusters,
    fingerprints,
    stats: {
      edgeCount: rows.length,
      clusterCount: clusterTotal,
      dupMethods: allClusters.reduce((a, c) => a + c.size, 0),
      reclaimLoc: allClusters.reduce((a, c) => a + c.loc - (c.members[0]?.lines ?? 0), 0),
      fpGroups: fpTotal,
      fpReclaimLoc,
      /** 明细封顶提示：调用方可据此提示「只显示前 N 组」 */
      clusterReturned: clusters.length,
      fpReturned: fingerprints.length,
    },
  };
}

/* ---------------------------------------------------------------- 架构图 */

const LOC_CACHE = new Map();

function fileLoc(rootPath, rel) {
  const key = `${rootPath}::${rel}`;
  if (LOC_CACHE.has(key)) return LOC_CACHE.get(key);
  let n = 0;
  try {
    const abs = path.join(rootPath, rel);
    const st = fs.statSync(abs);
    if (st.size < 2 * 1024 * 1024) {
      const buf = fs.readFileSync(abs);
      for (let i = 0; i < buf.length; i += 1) if (buf[i] === 10) n += 1;
      if (buf.length && buf[buf.length - 1] !== 10) n += 1;
    }
  } catch {
    n = 0;
  }
  LOC_CACHE.set(key, n);
  return n;
}

export function architecture(h, rootPath) {
  return cached(h, `architecture:${rootPath ?? ''}`, () => architectureUncached(h, rootPath));
}

function architectureUncached(h, rootPath) {
  const files = h.all(`SELECT id, name, file_path, properties FROM nodes WHERE label='File'`).map((r) => ({
    id: r.id,
    name: r.name,
    file: r.file_path || '',
    module: moduleOf(r.file_path),
    pkg: packageOf(r.file_path),
    ext: props(r).extension ?? path.extname(r.file_path || ''),
    lastModified: props(r).last_modified ?? null,
    changeCount: props(r).change_count ?? 0,
    loc: rootPath ? fileLoc(rootPath, r.file_path || '') : 0,
  }));

  const mods = new Map();
  for (const f of files) {
    if (!mods.has(f.module)) mods.set(f.module, { name: f.module, files: 0, loc: 0, changes: 0, pkgs: new Set() });
    const m = mods.get(f.module);
    m.files += 1;
    m.loc += f.loc;
    m.changes += f.changeCount;
    m.pkgs.add(f.pkg);
  }
  // 方法级复杂度挂到模块上：走副库聚合，避免读回 56 万行再逐行累加
  const side = analytics(h);
  const modRows = side.db
    ? side.all(`SELECT module, COUNT(*) n, SUM(complexity) cx FROM method_stats GROUP BY module`)
    : loadCodeNodes(h).map((c) => ({ module: c.module, n: 1, cx: c.complexity }));
  for (const r of modRows) {
    const m = mods.get(r.module);
    if (!m) continue;
    m.methods = (m.methods ?? 0) + r.n;
    m.cx = (m.cx ?? 0) + r.cx;
  }

  const importEdges = h.all(
    `SELECT ns.file_path AS s, nt.file_path AS t, COUNT(*) AS w
     FROM edges e JOIN nodes ns ON ns.id=e.source_id JOIN nodes nt ON nt.id=e.target_id
     WHERE e.project = ? AND e.type='IMPORTS' AND ns.label='File' AND nt.label='File' GROUP BY s, t`,
    [h.name]
  );
  const moduleAgg = new Map();
  const pkgAgg = new Map();
  for (const e of importEdges) {
    const sm = moduleOf(e.s);
    const tm = moduleOf(e.t);
    if (sm !== tm) {
      const k = `${sm}\u0000${tm}`;
      moduleAgg.set(k, (moduleAgg.get(k) ?? 0) + e.w);
    }
    const sp = packageOf(e.s);
    const tp = packageOf(e.t);
    if (sp !== tp) {
      const k = `${sp}\u0000${tp}`;
      pkgAgg.set(k, (pkgAgg.get(k) ?? 0) + e.w);
    }
  }
  const toEdges = (agg) => [...agg.entries()].map(([k, w]) => {
    const [s, t] = k.split('\u0000');
    return { s, t, w };
  });

  // 包级图只保留权重最高的若干边，避免面条图
  const pkgEdges = toEdges(pkgAgg).sort((a, b) => b.w - a.w || a.s.localeCompare(b.s) || a.t.localeCompare(b.t)).slice(0, 120);
  const keep = new Set();
  for (const e of pkgEdges) {
    keep.add(e.s);
    keep.add(e.t);
  }
  const pkgNodes = [...keep].sort().map((name) => {
    const fs_ = files.filter((f) => f.pkg === name);
    const codes = [];
    return {
      id: name,
      label: name.split('.').slice(-2).join('.') || name,
      full: name,
      module: moduleOf(fs_[0]?.file ?? ''),
      files: fs_.length,
      loc: fs_.reduce((a, f) => a + f.loc, 0),
      codes,
    };
  });

  // 目录树
  const tree = { name: '.', path: '', children: new Map() };
  for (const f of files) {
    const segs = (f.file || f.name).split('/');
    let cur = tree;
    segs.forEach((seg, i) => {
      const p = segs.slice(0, i + 1).join('/');
      if (!cur.children.has(seg)) cur.children.set(seg, { name: seg, path: p, children: new Map(), loc: 0, files: 0 });
      cur = cur.children.get(seg);
      cur.loc += f.loc;
      if (i === segs.length - 1) cur.files += 1;
    });
  }
  const serialize = (n) => ({
    name: n.name,
    path: n.path,
    loc: n.loc,
    files: n.files,
    children: [...n.children.values()].sort((a, b) => b.loc - a.loc).map(serialize),
  });

  return {
    modules: [...mods.values()]
      .map((m) => ({
        name: m.name,
        files: m.files,
        pkgs: m.pkgs.size,
        loc: m.loc,
        changes: m.changes,
        methods: m.methods ?? 0,
        avgCx: m.methods ? +((m.cx ?? 0) / m.methods).toFixed(2) : 0,
      }))
      .sort((a, b) => b.loc - a.loc),
    moduleEdges: toEdges(moduleAgg).sort((a, b) => b.w - a.w),
    packageNodes: pkgNodes,
    packageEdges: pkgEdges,
    tree: serialize(tree).children,
    fileCount: files.length,
    totalLoc: files.reduce((a, f) => a + f.loc, 0),
    extStats: Object.entries(
      files.reduce((a, f) => {
        const e = f.ext || '(none)';
        a[e] = (a[e] ?? 0) + 1;
        return a;
      }, {})
    )
      .map(([ext, n]) => ({ ext, n }))
      .sort((a, b) => b.n - a.n),
  };
}

/* -------------------------------------------------- 调用链路（正向 / 反向） */

const TYPE_LABELS = ['Class', 'Interface', 'Enum'];
const CALLABLE_LABELS = ['Method', 'Function'];

/** 包名匹配：精确 / 子包前缀 / 省略顶层包的后缀 */
function packageHit(pkg, needle) {
  const p = (pkg || '').toLowerCase();
  if (!p) return false;
  return p === needle || p.startsWith(`${needle}.`) || p.endsWith(`.${needle}`) || p.includes(`.${needle}.`);
}

function clampInt(v, min, max, dflt) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : dflt;
}

/**
 * 调用链路展开。
 *
 *   dir = 'up'   谁调用了它：沿 CALLS 边反向，链路 = 最外层调用方 → … → 目标
 *   dir = 'down' 它调用了谁：沿 CALLS 边正向，链路 = 目标 → … → 叶子
 *
 * 目标解析顺序：显式 id（列表里点选）→ 类名精确 → 包名（含子包）→ 方法名精确 → 名称模糊。
 * 类命中时把该类下所有方法一并作为目标（类节点本身不参与 CALLS）。
 *
 * 跨接口跳转：实现方法 --OVERRIDE--> 接口/父类方法。
 *   - 反向时，接口方法作为「派发」中间跳（Controller 调接口、运行期落到实现类），
 *     否则 Spring 的 Service 实现类永远查不到调用方；
 *   - 正向时，接口方法会派发到所有实现方法，否则链路在接口处中断。
 * 这类跳转不是 CALLS 边，步上标 virtual，界面单独标注。
 */
export function callChains(h, opts = {}) {
  const raw = String(opts.q ?? '').trim();
  const pickedId = Number(opts.id) || 0;
  const dir = opts.dir === 'down' ? 'down' : 'up';
  const depth = clampInt(opts.depth ?? 4, 1, 10, 4);
  const maxChains = clampInt(opts.limit ?? 200, 10, 500, 200);

  const empty = {
    query: raw,
    dir,
    mode: 'none',
    depth,
    matched: [],
    chains: [],
    directCallers: [],
    directCallees: [],
    suggest: [],
    stats: {
      matched: 0, targets: 0, directCallers: 0, directCallees: 0, chains: 0,
      truncated: false, orphanTargets: 0, leafTargets: 0, cutChains: 0,
      indirectChains: 0, rootEntries: 0, maxHops: 0, edgeCount: 0,
      viaHops: { exact: 0, inferred: 0, suspect: 0 }, suspectChains: 0, suspectHops: 0, inferredHops: 0,
    },
  };
  if (!pickedId && raw.length < 2) return empty;

  /*
   * 节点元数据改为「按需取 + 缓存」。
   * 旧实现把 7 类节点全量装进 Map（百万节点下 67 万行、实测 5.9s），
   * 而一次链路查询真正用到的节点不过几百个。
   */
  const meta = new Map();
  const metaOf = (id) => {
    const hit = meta.get(id);
    if (hit !== undefined) return hit;
    const n = h.one(
      `SELECT id, label, name, qualified_name, file_path, start_line, properties
       FROM nodes WHERE project = ? AND id = ?`,
      [h.name, id]
    );
    const d = props(n);
    const v = n
      ? {
          id: n.id,
          label: n.label,
          name: n.name,
          qn: n.qualified_name || '',
          file: n.file_path || '',
          line: n.start_line || 0,
          cls: d.parent_class ? String(d.parent_class).split('.').pop() : '',
          pkg: packageOf(n.file_path),
          isEntry: !!d.is_entry_point || !!d.route_path,
          type: TYPE_LABELS.includes(n.label),
          callable: CALLABLE_LABELS.includes(n.label),
        }
      : null;
    meta.set(id, v);
    return v;
  };
  const toMetaList = (ids) => ids.map(metaOf).filter(Boolean);

  /* ------------------------------- 1. 解析目标（全部走索引） ------------------------------- */
  const lq = raw.toLowerCase();
  const typePh = TYPE_LABELS.map(() => '?').join(',');
  let mode = 'none';
  let picked = [];
  if (pickedId) {
    const hit = metaOf(pickedId);
    if (hit) {
      mode = 'picked';
      picked = [hit];
    }
  } else {
    const exactTypes = toMetaList(
      h
        .all(`SELECT id FROM nodes WHERE project = ? AND label IN (${typePh}) AND lower(name) = ? LIMIT 80`, [
          h.name,
          ...TYPE_LABELS,
          lq,
        ])
        .map((r) => r.id)
    );
    const pkgTypes = exactTypes.length
      ? []
      : toMetaList(
          h
            .all(
              `SELECT id FROM nodes WHERE project = ? AND label IN (${typePh})
               AND (lower(file_path) LIKE ? OR lower(qualified_name) LIKE ?) LIMIT 80`,
              [h.name, ...TYPE_LABELS, `%${lq}%`, `%${lq}%`]
            )
            .map((r) => r.id)
        );
    const exactCallables =
      exactTypes.length || pkgTypes.length
        ? []
        : toMetaList(
            h
              .all(
                `SELECT id FROM nodes WHERE project = ? AND label IN ('Method','Function') AND lower(name) = ? LIMIT 80`,
                [h.name, lq]
              )
              .map((r) => r.id)
          );
    if (exactTypes.length) {
      mode = 'class';
      picked = exactTypes;
    } else if (pkgTypes.length) {
      mode = 'package';
      picked = pkgTypes;
    } else if (exactCallables.length) {
      mode = 'method';
      picked = exactCallables;
    } else {
      // 兜底模糊：只认类型节点，避免把一堆 getXxx 拖进来
      const fuzzy = toMetaList(
        h
          .all(
            `SELECT id FROM nodes WHERE project = ? AND label IN (${typePh})
             AND (lower(name) LIKE ? OR lower(qualified_name) LIKE ?) LIMIT 80`,
            [h.name, ...TYPE_LABELS, `%${lq}%`, `%${lq}%`]
          )
          .map((r) => r.id)
      );
      if (fuzzy.length) {
        mode = 'name';
        picked = fuzzy;
      }
    }
  }

  if (!picked.length) {
    const near = h
      .all(`SELECT name AS n FROM nodes WHERE project = ? AND label IN (${typePh}) LIMIT 8`, [h.name, ...TYPE_LABELS])
      .map((r) => r.n);
    return { ...empty, suggest: near };
  }

  /* --------------------- 2. 目标集合：类 + 类下所有方法（DEFINES_METHOD） --------------------- */
  const targetSet = new Set();
  for (const m of picked.slice(0, 80)) {
    if (!m.type) {
      targetSet.add(m.id);
      continue;
    }
    const kids = h.all(
      `SELECT target_id AS id FROM edges WHERE project = ? AND source_id = ? AND type = 'DEFINES_METHOD' LIMIT 200`,
      [h.name, m.id]
    );
    // 类没有可调用成员时（常量类、枚举）保留节点本身
    if (!kids.length) targetSet.add(m.id);
    for (const k of kids) targetSet.add(k.id);
  }
  const targetIds = [...targetSet].slice(0, 400);

  /* ------------- 3. 双向邻接（按需查询 + 缓存；不再全量载入数百万条边） ------------- */
  const viaHops = { exact: 0, inferred: 0, suspect: 0 };
  const outCache = new Map();
  const inCache = new Map();
  const nbrs = (id, d) => {
    const cache = d === 'out' ? outCache : inCache;
    const hit = cache.get(id);
    if (hit) return hit;
    const list = callNeighbors(h, [id], d, h.name).get(id) ?? [];
    for (const e of list) viaHops[e.via.kind] += 1;
    cache.set(id, list);
    return list;
  };

  const ovrParents = new Map(); // 实现方法 -> 接口/父类方法
  const ovrImpls = new Map(); // 接口/父类方法 -> 实现方法
  const loadParents = (id) => {
    if (!ovrParents.has(id)) {
      ovrParents.set(
        id,
        h.all(`SELECT target_id AS t FROM edges WHERE project = ? AND source_id = ? AND type='OVERRIDE'`, [h.name, id]).map((r) => r.t)
      );
    }
    return ovrParents.get(id);
  };
  const loadImpls = (id) => {
    if (!ovrImpls.has(id)) {
      ovrImpls.set(
        id,
        h.all(`SELECT source_id AS s FROM edges WHERE project = ? AND target_id = ? AND type='OVERRIDE'`, [h.name, id]).map((r) => r.s)
      );
    }
    return ovrImpls.get(id);
  };
  const dispatchOf = (id) => (dir === 'up' ? loadParents(id) : loadImpls(id));
  const nextOf = (id) => nbrs(id, dir === 'up' ? 'in' : 'out');
  // 全库 CALLS 边数（用于统计展示）：取副库物化计数，避免再扫一遍边表
  const edgeCount = analytics(h).one?.(`SELECT n FROM counts WHERE kind='edge' AND name='CALLS'`)?.n ?? 0;

  /* --------------------------- 4. 展开链路（DFS） --------------------------- */
  const chains = [];
  const seen = new Set();
  let truncated = false;
  let orphans = 0;
  let leaves = 0;

  const record = (path, cut) => {
    const sig = path.map((p) => p.id).join('>');
    if (seen.has(sig)) return;
    seen.add(sig);
    chains.push({ cut, steps: path });
  };

  const walk = (id, path) => {
    if (chains.length >= maxChains) {
      truncated = true;
      return;
    }
    const next = nextOf(id);
    const dispatch = dispatchOf(id).slice(0, 8);
    const hops = path.length - 1;
    if (!next.length && !dispatch.length) {
      if (hops > 0) record(path, false);
      else if (dir === 'up') orphans += 1;
      else leaves += 1;
      return;
    }
    if (hops >= depth) {
      record(path, true);
      return;
    }
    for (const c of next) {
      if (path.some((p) => p.id === c.id)) continue; // 环
      walk(c.id, [...path, { id: c.id, callLine: c.line, virtual: false, via: c.via }]);
      if (chains.length >= maxChains) {
        truncated = true;
        return;
      }
    }
    for (const t of dispatch) {
      if (path.some((p) => p.id === t)) continue;
      walk(t, [...path, { id: t, callLine: 0, virtual: true }]);
      if (chains.length >= maxChains) {
        truncated = true;
        return;
      }
    }
  };

  for (const tid of targetIds) {
    walk(tid, [{ id: tid, callLine: 0, virtual: false }]);
    if (chains.length >= maxChains) {
      truncated = true;
      break;
    }
  }

  const toStep = (s) => {
    const m = metaOf(s.id) ?? { name: `#${s.id}`, label: '', cls: '', file: '', line: 0, isEntry: false };
    return {
      id: s.id,
      name: m.name,
      label: m.label,
      cls: m.cls,
      file: m.file,
      line: m.line,
      callLine: s.callLine ?? 0,
      isEntry: !!m.isEntry,
      virtual: !!s.virtual,
      /** 这一跳是怎么解析出来的：exact / inferred / suspect；派发跳与根节点为 null */
      via: s.via ?? null,
    };
  };

  const outChains = chains
    .map((c) => {
      const steps = (dir === 'up' ? [...c.steps].reverse() : c.steps).map(toStep);
      // 一条链里有几步不可信：给界面做质量摘要，不用来过滤
      const suspect = steps.filter((s) => s.via?.kind === 'suspect').length;
      const inferred = steps.filter((s) => s.via?.kind === 'inferred').length;
      return { hops: steps.length - 1, cut: c.cut, entry: steps[0]?.isEntry ?? false, suspect, inferred, steps };
    })
    .sort((a, b) =>
      dir === 'up'
        ? a.hops - b.hops || (a.steps[0]?.name ?? '').localeCompare(b.steps[0]?.name ?? '')
        : b.hops - a.hops || (a.steps[0]?.name ?? '').localeCompare(b.steps[0]?.name ?? '')
    );

  /* ------------------------- 5. 直接相邻节点汇总 ------------------------- */
  const pack = (map) =>
    [...map.values()]
      .map((d) => {
        const m = metaOf(d.id) ?? { name: `#${d.id}`, cls: '', file: '', line: 0, label: '', isEntry: false };
        return {
          id: d.id,
          name: m.name,
          cls: m.cls,
          label: m.label,
          file: m.file,
          line: m.line,
          calls: d.calls,
          isEntry: !!m.isEntry,
          viaDispatch: d.viaDispatch,
        };
      })
      .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name))
      .slice(0, 50);

  const directCallersMap = new Map();
  const directCalleesMap = new Map();
  const addTo = (map, id, viaDispatch) => {
    const d = map.get(id) ?? { id, calls: 0, viaDispatch: false };
    d.calls += 1;
    d.viaDispatch = d.viaDispatch || viaDispatch;
    map.set(id, d);
  };
  for (const tid of targetIds) {
    if (dir === 'up') {
      for (const c of nbrs(tid, 'in')) addTo(directCallersMap, c.id, false);
      for (const p of loadParents(tid)) for (const c of nbrs(p, 'in')) addTo(directCallersMap, c.id, true);
    } else {
      for (const c of nbrs(tid, 'out')) addTo(directCalleesMap, c.id, false);
      for (const t of loadImpls(tid)) addTo(directCalleesMap, t, true);
    }
  }

  const directCallers = pack(directCallersMap);
  const directCallees = pack(directCalleesMap);

  return {
    query: raw,
    dir,
    mode,
    depth,
    matched: picked.slice(0, 20).map((m) => ({ id: m.id, name: m.name, label: m.label, file: m.file, line: m.line, pkg: m.pkg })),
    chains: outChains,
    directCallers,
    directCallees,
    suggest: [],
    stats: {
      matched: picked.length,
      targets: targetIds.length,
      directCallers: directCallersMap.size,
      directCallees: directCalleesMap.size,
      chains: outChains.length,
      truncated,
      orphanTargets: orphans,
      leafTargets: leaves,
      cutChains: outChains.filter((c) => c.cut).length,
      indirectChains: outChains.filter((c) => c.steps.some((s) => s.virtual)).length,
      rootEntries: outChains.filter((c) => c.entry).length,
      maxHops: outChains.reduce((a, c) => Math.max(a, c.hops), 0),
      edgeCount,
      /** 全库调用边的解析溯源分布（exact/inferred/suspect）+ 当前链里被标红的跳数 */
      viaHops,
      suspectChains: outChains.filter((c) => c.suspect > 0).length,
      suspectHops: outChains.reduce((a, c) => a + c.suspect, 0),
      inferredHops: outChains.reduce((a, c) => a + c.inferred, 0),
    },
  };
}

/* ------------------------------------- 逐层下钻：模块 → 包 → 类 → 方法 */

const dirOf = (f) => (f || '').split('/').slice(0, -1).join('/');

/** 源码里的类型节点（Class / Interface / Enum），去掉 XML 伪类与 vendor 目录 */
function typeRows(h) {
  const ph = TYPE_LABELS.map(() => '?').join(',');
  return h
    .all(`SELECT id, label, name, qualified_name, file_path, start_line FROM nodes WHERE label IN (${ph})`, TYPE_LABELS)
    .filter((r) => CODE_FILE.test(r.file_path || '') && !VENDOR_PATH.test(r.file_path || ''));
}

/**
 * 类 / 方法在 CALLS 图里的进出度数；类级由成员方法汇总。
 *
 * 用 SQL 聚合取代「把百万级 CALLS 边全量读进 JS 再计数」
 * （实测 336 万条边全量载入 14.3s，聚合后为秒级且不占内存）。
 */
function degrees(h) {
  const inD = new Map();
  const outD = new Map();
  const toMap = (rows, key) => {
    const m = new Map();
    for (const r of rows) m.set(r[key], r.n);
    return m;
  };
  const outRows = h.all(
    `SELECT e.source_id AS k, COUNT(*) AS n FROM edges e
     JOIN nodes tn ON tn.id = e.target_id
     WHERE e.project = ? AND e.type='CALLS' AND tn.label IN ('Method','Function')
     GROUP BY e.source_id`,
    [h.name]
  );
  for (const [k, v] of toMap(outRows, 'k')) outD.set(k, v);
  const inRows = h.all(
    `SELECT e.target_id AS k, COUNT(*) AS n FROM edges e
     JOIN nodes tn ON tn.id = e.target_id
     WHERE e.project = ? AND e.type='CALLS' AND tn.label IN ('Method','Function')
     GROUP BY e.target_id`,
    [h.name]
  );
  for (const [k, v] of toMap(inRows, 'k')) inD.set(k, v);

  const classAgg = new Map();
  // parent_class 从副库取（普通列，避免逐行 JSON 解析）
  const side = analytics(h);
  const memberRows = side.db
    ? side.all(`SELECT id, file, parent_class AS pc FROM method_stats`)
    : h.all(`SELECT id, file_path AS file, properties FROM nodes WHERE label IN ('Method','Function')`).map((r) => {
        const pc = props(r).parent_class;
        return { id: r.id, file: r.file_path || '', pc };
      });
  for (const r of memberRows) {
    const file = r.file || '';
    if (!CODE_FILE.test(file) || VENDOR_PATH.test(file)) continue;
    const pc = r.pc;
    if (!pc) continue;
    const key = `${dirOf(file)}\u0000${String(pc).split('.').pop()}`;
    const a = classAgg.get(key) ?? { members: 0, in: 0, out: 0 };
    a.members += 1;
    a.in += inD.get(r.id) ?? 0;
    a.out += outD.get(r.id) ?? 0;
    classAgg.set(key, a);
  }
  return { inD, outD, classAgg };
}

/** 一个模块内所有包名的公共前缀（按段比较）——Java 项目可从 com.ruoyi.system 起步，少点好几层 */
function commonPkgPrefix(pkgs, sep) {
  if (!pkgs.length) return '';
  const lists = pkgs.map((p) => p.split(sep));
  const min = Math.min(...lists.map((l) => l.length));
  let k = 0;
  while (k < min && lists.every((l) => l[k] === lists[0][k])) k += 1;
  return lists[0].slice(0, k).join(sep);
}

function classRow(r, agg) {
  const a = agg.get(`${dirOf(r.file_path)}\u0000${r.name}`) ?? { members: 0, in: 0, out: 0 };
  return {
    level: 'class',
    key: String(r.id),
    id: r.id,
    name: r.name,
    kind: r.label,
    cls: '',
    file: r.file_path || '',
    line: r.start_line || 0,
    members: a.members,
    inCalls: a.in,
    outCalls: a.out,
    count: a.members,
    hasChildren: a.members > 0,
    sub: `${a.members} 个方法 · 入 ${a.in} 出 ${a.out}`,
  };
}

/**
 * 调用链路的起点选择器：不让人手打全名，改成 模块 → 包 → 类 → 方法 一层层点。
 *
 *   level=module               列出顶层模块
 *   level=package&module=X     列出该模块下的下一层子包 + 直属类（包名从公共前缀起算，自动跳过 com/ruoyi 这种空层）
 *   level=method&classId=N     列出该类的成员方法
 */
export function browse(h, opts = {}) {
  const level = ['module', 'package', 'method'].includes(opts.level) ? opts.level : 'module';
  const module = String(opts.module ?? '').trim();
  const pkg = String(opts.pkg ?? '').trim();
  const classId = Number(opts.classId) || 0;
  const raw = String(opts.q ?? '').trim();
  const q = raw.toLowerCase();
  const hit = (s) => !q || String(s ?? '').toLowerCase().includes(q);

  const scope = { module, pkg, classId, className: '', classFile: '' };
  let base = '';
  let rows = [];

  if (level === 'module') {
    const types = typeRows(h);
    const m = new Map();
    for (const r of types) {
      const name = moduleOf(r.file_path);
      const a = m.get(name) ?? { classes: 0, files: new Set() };
      a.classes += 1;
      a.files.add(r.file_path);
      m.set(name, a);
    }
    rows = [...m.entries()]
      .map(([name, a]) => ({
        level: 'module',
        key: name,
        name,
        kind: 'module',
        count: a.classes,
        hasChildren: true,
        sub: `${a.classes} 个类 · ${a.files.size} 个文件`,
      }))
      .filter((r) => hit(r.name))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  } else if (level === 'package') {
    const types = typeRows(h).filter((r) => moduleOf(r.file_path) === module);
    const byPkg = new Map();
    for (const r of types) {
      const p = packageOf(r.file_path);
      byPkg.set(p, (byPkg.get(p) ?? 0) + 1);
    }
    const pkgs = [...byPkg.keys()];
    const sep = pkgs.some((p) => p.includes('/')) ? '/' : '.';
    base = commonPkgPrefix(pkgs, sep);
    const prefix = pkg || base;
    scope.pkg = prefix;

    const groups = new Map();
    for (const p of pkgs) {
      if (prefix && p !== prefix && !p.startsWith(`${prefix}${sep}`)) continue;
      const rest = prefix ? (p === prefix ? '' : p.slice(prefix.length + sep.length)) : p;
      if (!rest) continue;
      const seg = rest.split(sep)[0];
      const key = prefix ? `${prefix}${sep}${seg}` : seg;
      const g = groups.get(key) ?? { key, name: seg, classes: 0, subs: new Set() };
      g.classes += byPkg.get(p) ?? 0;
      if (rest.includes(sep)) g.subs.add(rest.split(sep)[1]);
      groups.set(key, g);
    }

    const subRows = [...groups.values()]
      .map((g) => ({
        level: 'package',
        key: g.key,
        name: g.name,
        kind: 'package',
        count: g.classes,
        hasChildren: true,
        sub: `${g.classes} 个类${g.subs.size ? ` · ${g.subs.size} 个子包` : ''}`,
      }))
      .filter((r) => hit(r.name))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

    const deg = degrees(h);
    const classRows = prefix
      ? types.filter((r) => packageOf(r.file_path) === prefix)
          .map((r) => classRow(r, deg.classAgg))
          .filter((r) => hit(r.name))
          .sort((a, b) => b.inCalls + b.outCalls - (a.inCalls + a.outCalls) || a.name.localeCompare(b.name))
      : [];

    rows = [...subRows, ...classRows];
  } else {
    const cls = classId ? h.one('SELECT name, file_path FROM nodes WHERE id=?', [classId]) : null;
    if (cls) {
      scope.className = cls.name;
      scope.classFile = cls.file_path || '';
      const cdir = dirOf(cls.file_path);
      const deg = degrees(h);
      rows = h
        .all(`SELECT id, label, name, file_path, start_line, properties FROM nodes WHERE label IN ('Method','Function')`)
        .filter((r) => {
          const file = r.file_path || '';
          if (!CODE_FILE.test(file) || VENDOR_PATH.test(file)) return false;
          if (dirOf(file) !== cdir) return false;
          const pc = props(r).parent_class;
          return !!pc && String(pc).split('.').pop() === cls.name;
        })
        .map((r) => {
          const d = props(r);
          const cx = d.complexity ?? 0;
          const inC = deg.inD.get(r.id) ?? 0;
          const outC = deg.outD.get(r.id) ?? 0;
          return {
            level: 'method',
            key: String(r.id),
            id: r.id,
            name: r.name,
            kind: r.label,
            cls: cls.name,
            file: r.file_path || '',
            line: r.start_line || 0,
            complexity: cx,
            inCalls: inC,
            outCalls: outC,
            count: 0,
            hasChildren: false,
            sub: `复杂度 ${cx} · 入 ${inC} 出 ${outC}`,
          };
        })
        .filter((r) => hit(r.name))
        .sort((a, b) => b.inCalls + b.outCalls - (a.inCalls + a.outCalls) || a.name.localeCompare(b.name));
    }
  }

  const page = pageOf(rows, opts, 40);
  return { level, scope, base, applied: { q: raw }, ...page };
}

/* ---------------------------------------------------------------- 分层图 */

const LAYER_RULES = [
  { id: 'L0', label: 'L0 接入层', re: /(^|\/)(templates\/|static\/)|\.html$|\.ftl$|\.vue$|\.js$/i, hint: '页面/静态资源' },
  { id: 'L1', label: 'L1 接口层', re: /controller|Controller|\.api\.|\/api\/|route|Route|handler/i, hint: 'Controller / Route' },
  { id: 'L2', label: 'L2 应用服务层', re: /service|Service|aspect|Aspect|task|Task|job|Job|flow|Flow|manager|Manager/i, hint: 'Service / Aspect / 任务' },
  { id: 'L3', label: 'L3 领域模型层', re: /domain|entity|dto|vo\/|model|pojo|schema|dataclass|types\./i, hint: '实体 / DTO / 模型' },
  { id: 'L4', label: 'L4 持久化层', re: /mapper|Mapper|dao|Dao|repository|Repository|\.xml$|sql\//i, hint: 'Mapper / DAO / SQL' },
  { id: 'L5', label: 'L5 公共基础层', re: /common|core|config|framework|util|Util|annotation|constant|exception|helper|lib/i, hint: '工具 / 配置 / 框架' },
];

function layerOf(filePath) {
  const fp = (filePath || '').replace(/\\/g, '/');
  for (const r of LAYER_RULES) if (r.re.test(fp)) return r;
  return { id: 'LX', label: 'LX 其他', re: null, hint: '未被规则命中' };
}

export function layers(h) {
  return cached(h, 'layers', () => layersUncached(h));
}

function layersUncached(h) {
  const fileLayer = new Map();
  const files = h.all(`SELECT file_path, properties FROM nodes WHERE project = ? AND label='File'`, [h.name]);
  const stat = new Map();
  const ensure = (id, label, hint) => {
    if (!stat.has(id)) stat.set(id, { id, label, hint, files: 0, methods: 0, lines: 0, cx: 0, maxCx: 0, hotCx: 0 });
    return stat.get(id);
  };
  for (const r of LAYER_RULES) ensure(r.id, r.label, r.hint);
  ensure('LX', 'LX 其他', '未被规则命中');

  for (const f of files) {
    const l = layerOf(f.file_path);
    fileLayer.set(f.file_path, l.id);
    const s = ensure(l.id, l.label, l.hint);
    s.files += 1;
  }
  // 按文件聚合方法指标，再归层：副库 SQL 分组，避免 56 万行读回 + 逐行正则
  const side = analytics(h);
  const perFile = side.db
    ? side.all(
        `SELECT file, COUNT(*) methods, SUM(lines) lines, SUM(complexity) cx, MAX(complexity) maxCx,
                SUM(CASE WHEN complexity > ${HOT_COMPLEXITY} THEN 1 ELSE 0 END) hot
         FROM method_stats GROUP BY file`
      )
    : (() => {
        const m = new Map();
        for (const c of loadCodeNodes(h)) {
          const a = m.get(c.file) ?? { file: c.file, methods: 0, lines: 0, cx: 0, maxCx: 0, hot: 0 };
          a.methods += 1;
          a.lines += c.lines;
          a.cx += c.complexity;
          a.maxCx = Math.max(a.maxCx, c.complexity);
          if (isHot(c.complexity)) a.hot += 1;
          m.set(c.file, a);
        }
        return [...m.values()];
      })();
  for (const c of perFile) {
    const l = layerOf(c.file);
    fileLayer.set(c.file, l.id);
    const s = ensure(l.id, l.label, l.hint);
    s.methods += c.methods;
    s.lines += c.lines;
    s.cx += c.cx;
    s.maxCx = Math.max(s.maxCx, c.maxCx);
    s.hotCx += c.hot;
  }

  /*
   * 跨层调用。
   *
   * 旧写法 `edges JOIN nodes ns JOIN nodes nt ... GROUP BY sf, tf` 在百万节点下实测 65s：
   * 两次 JOIN（理解成 670 万次节点查找）+ 百万级分组结果再排序。
   * 改为「只取边的两端 id（走索引，约 11s）→ 用副库的 id→文件映射在 JS 里直接归并成层对」，
   * 分组规模从「(文件,文件) 百万级」降到「层×层」的个位数。
   */
  const flow = new Map();
  const sideFlow = analytics(h);
  const fileOfId = new Map();
  if (sideFlow.db) {
    for (const r of sideFlow.all('SELECT id, file FROM method_stats')) fileOfId.set(r.id, r.file);
  }
  const layerOfFile = (f) => {
    if (!f) return null;
    const got = fileLayer.get(f);
    if (got) return got;
    const id = layerOf(f).id;
    fileLayer.set(f, id);
    return id;
  };
  for (const e of h.all(`SELECT source_id AS s, target_id AS t FROM edges WHERE project = ? AND type='CALLS'`, [h.name])) {
    const sf = fileOfId.get(e.s);
    const tf = fileOfId.get(e.t);
    if (!sf || !tf) continue;
    const sl = layerOfFile(sf);
    const tl = layerOfFile(tf);
    if (!sl || sl === tl) continue;
    const k = `${sl}\u0000${tl}`;
    flow.set(k, (flow.get(k) ?? 0) + 1);
  }

  // HANDLES：接口 → Route 节点（外部可见边界）
  const handles = h.all(
    `SELECT ns.file_path AS sf, COUNT(*) AS w FROM edges e JOIN nodes ns ON ns.id=e.source_id
     WHERE e.project = ? AND e.type='HANDLES' GROUP BY sf`,
    [h.name]
  );
  const entries = handles.reduce((a, r) => a + r.w, 0);

  // 各层对外暴露的入口统计
  const layerNodes = [...stat.values()]
    .map((s) => ({
      ...s,
      avgCx: s.methods ? +(s.cx / s.methods).toFixed(2) : 0,
      loc: s.lines,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return {
    nodes: layerNodes,
    flows: [...flow.entries()]
      .map(([k, w]) => {
        const [s, t] = k.split('\u0000');
        return { s, t, w };
      })
      .sort((a, b) => b.w - a.w),
    externalEntries: entries,
  };
}

/* --------------------------------------------------------------- 路由图 */

export function routes(h, opts = {}) {
  return cached(h, `routes:${JSON.stringify(opts)}`, () => routesUncached(h, opts));
}

function routesUncached(h, opts = {}) {
  const rows = h.all(
    `SELECT r.name AS route, r.file_path AS rfile, r.properties AS rp,
            m.name AS mname, m.qualified_name AS mqn, m.file_path AS mfile, m.start_line AS mline, m.properties AS mp
     FROM edges e
     JOIN nodes r ON r.id=e.target_id AND r.label='Route'
     LEFT JOIN nodes m ON m.id=e.source_id AND m.label IN ('Method','Function')
     WHERE e.type='HANDLES'`
  );
  const byModule = new Map();
  const list = rows.map((r) => {
    const rp = props({ properties: r.rp });
    const mp = props({ properties: r.mp });
    const item = {
      route: r.route,
      http: rp.method ?? 'GET',
      handler: r.mname ?? '(未绑定)',
      cls: mp.parent_class ? String(mp.parent_class).split('.').pop() : '',
      file: r.mfile || r.rfile || '',
      line: r.mline || 0,
      complexity: mp.complexity ?? 0,
      lines: mp.lines ?? 0,
      module: moduleOf(r.mfile || r.rfile),
      pkg: packageOf(r.mfile || r.rfile),
    };
    if (!byModule.has(item.module)) byModule.set(item.module, []);
    byModule.get(item.module).push(item);
    return item;
  });
  const allRoutes = h.all(`SELECT name, properties FROM nodes WHERE label='Route'`);
  const methods = {};
  for (const r of allRoutes) {
    const m = props(r).method ?? 'GET';
    methods[m] = (methods[m] ?? 0) + 1;
  }

  /* ---------------- 明细：模块 / 方法 / 关键字 + 排序 + 分页 ---------------- */
  const wantModule = opts.module ?? '';
  const wantHttp = opts.http ?? '';
  const q = String(opts.q ?? '').trim().toLowerCase();
  const matched = list.filter((r) => {
    if (wantModule && r.module !== wantModule) return false;
    if (wantHttp && r.http !== wantHttp) return false;
    if (q) {
      const hay = `${r.route} ${r.handler} ${r.cls} ${r.file} ${r.pkg}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const cmp = {
    route: (a, b) => a.route.localeCompare(b.route) || a.handler.localeCompare(b.handler),
    complexity: (a, b) => b.complexity - a.complexity || a.route.localeCompare(b.route),
    handler: (a, b) => a.handler.localeCompare(b.handler) || a.route.localeCompare(b.route),
    module: (a, b) => a.module.localeCompare(b.module) || a.route.localeCompare(b.route),
    http: (a, b) => a.http.localeCompare(b.http) || a.route.localeCompare(b.route),
  }[opts.sort ?? 'route'] ?? ((a, b) => a.route.localeCompare(b.route));
  matched.sort(cmp);

  const page = pageOf(matched, opts);
  return {
    ...page,
    byModule: [...byModule.entries()].map(([name, items]) => ({ module: name, items })),
    httpMethods: methods,
    total: allRoutes.length,
    bound: list.length,
    applied: { module: wantModule, http: wantHttp, q, sort: opts.sort ?? 'route', page: String(page.page), pageSize: String(page.pageSize) },
  };
}

/* -------------------------------------------------------------- 索引质量 */

export function coverage(h) {
  return cached(h, 'coverage', () => coverageUncached(h));
}

function coverageUncached(h) {
  const rows = h.all(`SELECT rel_path, kind, detail FROM index_coverage ORDER BY kind, rel_path`);
  const byKind = new Map();
  for (const r of rows) {
    if (!byKind.has(r.kind)) byKind.set(r.kind, []);
    byKind.get(r.kind).push(r);
  }
  const fileHashes = h.one('SELECT COUNT(*) AS n FROM file_hashes')?.n ?? 0;
  const lsp = h.one('SELECT COUNT(*) AS n FROM lsp_surface')?.n ?? 0;
  const nodes = h.one('SELECT COUNT(*) AS n FROM nodes')?.n ?? 0;
  const withBody = h.one(`SELECT COUNT(*) AS n FROM nodes_fts`)?.n ?? 0;
  const meta = h.all('SELECT k, v FROM store_meta');
  return {
    kinds: [...byKind.entries()].map(([kind, items]) => ({
      kind,
      label:
        {
          not_indexed_dir: '未索引目录',
          not_indexed_file: '未索引文件',
          parse_partial: '部分解析失败',
        }[kind] ?? kind,
      count: items.length,
      items: items.slice(0, 40),
    })),
    stats: { fileHashes, lspSurfaces: lsp, nodes, ftsRows: withBody },
    meta,
  };
}

/* -------------------------------------------------------------- 检索/详情 */

export function search(h, q, limit = 40) {
  if (!q || !q.trim()) return { query: q, hits: [] };
  const safe = q.replace(/["']/g, ' ').trim();
  let rows = [];
  try {
    rows = h.all(
      `SELECT f.rowid AS id FROM nodes_fts f WHERE nodes_fts MATCH ? LIMIT ?`,
      [`${safe}*`, limit]
    );
  } catch {
    rows = [];
  }
  if (!rows.length) {
    rows = h.all(
      `SELECT id FROM nodes WHERE name LIKE ? OR qualified_name LIKE ? OR file_path LIKE ? LIMIT ?`,
      [`%${q}%`, `%${q}%`, `%${q}%`, limit]
    );
  }
  const ids = rows.map((r) => r.id);
  if (!ids.length) return { query: q, hits: [] };
  const ph = ids.map(() => '?').join(',');
  const details = h.all(`SELECT id, label, name, qualified_name, file_path, start_line, end_line, properties FROM nodes WHERE id IN (${ph})`, ids);
  const hits = details.map((r) => {
    const d = props(r);
    return {
      id: r.id,
      label: r.label,
      name: r.name,
      qn: r.qualified_name,
      file: r.file_path || '',
      line: r.start_line || 0,
      endLine: r.end_line || 0,
      complexity: d.complexity ?? null,
      lines: d.lines ?? null,
      cls: d.parent_class ? String(d.parent_class).split('.').pop() : '',
      doc: (d.docstring ?? '').replace(/\s+/g, ' ').slice(0, 160),
    };
  });
  return { query: q, hits };
}

export function nodeDetail(h, id) {
  const r = h.one(`SELECT id, label, name, qualified_name, file_path, start_line, end_line, properties FROM nodes WHERE id=?`, [id]);
  if (!r) return null;
  const d = props(r);
  const out = h.all(
    `SELECT e.type, n.id, n.label, n.name, n.qualified_name, n.file_path, n.start_line, e.properties
     FROM edges e JOIN nodes n ON n.id=e.target_id WHERE e.source_id=? LIMIT 60`,
    [id]
  );
  const inc = h.all(
    `SELECT e.type, n.id, n.label, n.name, n.qualified_name, n.file_path, n.start_line, e.properties
     FROM edges e JOIN nodes n ON n.id=e.source_id WHERE e.target_id=? LIMIT 60`,
    [id]
  );
  const map = (rows) => rows.map((x) => ({ type: x.type, id: x.id, label: x.label, name: x.name, file: x.file_path || '', line: x.start_line || 0 }));
  return {
    node: { id: r.id, label: r.label, name: r.name, qn: r.qualified_name, file: r.file_path || '', startLine: r.start_line || 0, endLine: r.end_line || 0, props: d },
    outgoing: map(out),
    incoming: map(inc),
  };
}

export function sourceSnippet(rootPath, relPath, start, end, context = 4) {
  if (!rootPath || !relPath) return null;
  const abs = path.join(rootPath, relPath.replace(/\//g, path.sep));
  if (!abs.startsWith(path.resolve(rootPath))) return null;
  try {
    const text = fs.readFileSync(abs, 'utf8');
    const lines = text.split(/\r?\n/);
    const s = Math.max(1, (start || 1) - context);
    const e = Math.min(lines.length, (end || start || 1) + context);
    return {
      path: relPath,
      totalLines: lines.length,
      start: s,
      end: e,
      lines: lines.slice(s - 1, e).map((t, i) => ({ n: s + i, t })),
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------ 无引用代码（死代码） */

/**
 * 哪些入边才算“真的被引用”。
 * DEFINES / DEFINES_METHOD / CONTAINS_* 是结构边，任何节点都有，不能算引用。
 */
const REF_EDGES = {
  Method: ['CALLS', 'USAGE', 'OVERRIDE'],
  Function: ['CALLS', 'USAGE', 'OVERRIDE'],
  Class: ['USAGE', 'CALLS', 'IMPORTS', 'INHERITS', 'IMPLEMENTS', 'DECORATES', 'THROWS'],
  Interface: ['USAGE', 'CALLS', 'IMPORTS', 'INHERITS', 'IMPLEMENTS', 'DECORATES', 'THROWS'],
  Enum: ['USAGE', 'CALLS', 'IMPORTS', 'INHERITS', 'IMPLEMENTS', 'DECORATES', 'THROWS'],
  Field: ['USAGE', 'WRITES', 'CALLS'],
  Variable: ['USAGE', 'WRITES', 'CALLS'],
};

/** 命中即“不建议删”：框架/容器/序列化会在运行时反向调用，静态看不到 */
const KEEP_ANNOTATIONS = new Set([
  'Override', 'Bean', 'PostConstruct', 'PreDestroy', 'Autowired', 'Resource', 'Value',
  'Scheduled', 'EventListener', 'KafkaListener', 'RabbitListener', 'JmsListener', 'StreamListener',
  'ExceptionHandler', 'ControllerAdvice', 'RestControllerAdvice',
  'RequestMapping', 'GetMapping', 'PostMapping', 'PutMapping', 'DeleteMapping', 'PatchMapping',
  'Aspect', 'Around', 'Before', 'After', 'AfterReturning', 'AfterThrowing',
  'ConfigurationProperties', 'ConditionalOnProperty', 'SpringBootApplication',
  'FeignClient', 'Mapper', 'TableName', 'Entity', 'Id', 'Column', 'TableField',
  'Test', 'ParameterizedTest', 'BeforeEach', 'AfterEach', 'BeforeAll', 'AfterAll',
  'JsonProperty', 'JsonIgnore', 'XmlElement',
]);

const KEEP_NAMES = new Set([
  'main', 'init', 'destroy', 'afterPropertiesSet', 'run', 'call', 'apply', 'accept',
  'toString', 'equals', 'hashCode', 'compareTo', 'clone', 'finalize', 'readObject', 'writeObject',
  'iterator', 'hasNext', 'next', 'close', 'configure', 'setUp', 'tearDown',
]);

const STEREOTYPE_SUFFIX =
  /(Controller|RestController|Service|ServiceImpl|Mapper|Dao|Repository|Config|Configuration|Application|Aspect|Filter|Interceptor|Handler|Listener|Job|Task|Advice|Converter|Serializer|Deserializer|Validator|Provider|Factory|Builder|Entity|Vo|Dto|Bo)$/;

const FRAMEWORK_PATH =
  /\/(controller|service|mapper|dao|repository|aspect|config|handler|listener|job|task|api)\//i;

/**
 * 只扫真正的源码文件。
 * 索引器会把 XML 标签（pom.xml 的 <project>、logback.xml 的 <configuration>）也标成 Class，
 * 放进“无引用类”里是纯噪声——这类节点必须排除。
 */
const CODE_FILE =
  /\.(java|kt|kts|scala|groovy|py|pyi|ts|tsx|js|jsx|mjs|cjs|vue|svelte|go|rs|cs|c|cc|cpp|cxx|h|hpp|swift|php|rb|lua|dart|sh)$/i;

const VENDOR_PATH = /(^|\/)(node_modules|target|dist|build|out|vendor|\.git)\//i;

/** 测试代码：索引器的 is_test 在部分语言/目录结构下不可靠，按路径兜底 */
const TEST_PATH =
  /(^|\/)(tests?|__tests__|spec|testing)\/|(^|\/)test_[^/]*\.py$|_test\.(py|go|rs)$|(^|\/)Test[A-Z][^/]*\.(java|kt|cs)$|\/src\/test\//i;

/** 动态派发语言：静态图看不到 getattr / 反射 / 装饰器路由，不能直接判可删 */
const DYNAMIC_LANG = /\.(py|pyi|js|jsx|ts|tsx|mjs|cjs|vue|rb|php|lua|dart)$/i;

function isScannableSource(file) {
  if (!file) return false;
  if (VENDOR_PATH.test(file)) return false;
  if (rules().excludeRes.some((re) => re.test(file))) return false;
  return CODE_FILE.test(file);
}

/** 测试代码判定：内置规则 + 配置页追加的正则 */
function isTestPath(file) {
  if (!file) return false;
  if (TEST_PATH.test(file)) return true;
  return rules().testRes.some((re) => re.test(file));
}

function decoratorsOf(d) {
  const raw = d.decorators ?? d.decorator_tags ?? [];
  const arr = Array.isArray(raw) ? raw : String(raw).split(',');
  return arr
    .map((x) => String(x).trim().replace(/^@/, '').split('(')[0])
    .filter(Boolean);
}

/** 注解可能在文件头（package / import 之后、类声明之前） */
const HEAD_BYTES = 8192;

/**
 * 从源码头部补注解。
 * 索引器对 Java 类大多不记 decorators，只靠图里的注解会漏；
 * 仅在「排除规则里出现 @」时才调用，且每个文件只读一次。
 */
function annotationsFromSource(absFile) {
  let fd;
  try {
    fd = fs.openSync(absFile, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    const head = buf.subarray(0, n).toString('utf8');
    return [...head.matchAll(/^\s*@([A-Za-z_][\w.]*)/gm)].map((m) => m[1]);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* 忽略关闭失败 */
      }
    }
  }
}

/** 单节点分级：low=低风险可删 / review=需人工复核 / keep=不建议删 */
function gradeNode(node, d, refs, opts) {
  const reasons = [];
  const label = node.label;
  const name = node.name || '';
  const parent = d.parent_class ? String(d.parent_class).split('.').pop() : '';
  const decorators = decoratorsOf(d);
  const file = node.file_path || '';

  if (opts.isTest) {
    reasons.push('测试代码（索引标记为 test）');
    return { risk: 'keep', reasons };
  }
  if (opts.isEntry) {
    reasons.push(d.route_path ? `HTTP 入口 ${d.route_method ?? ''} ${d.route_path}`.trim() : '框架入口点（is_entry_point）');
    return { risk: 'keep', reasons };
  }
  if (KEEP_NAMES.has(name)) {
    reasons.push(`框架/语言约定方法名 ${name}()`);
    return { risk: 'keep', reasons };
  }
  const keepAnn = decorators.filter((x) => KEEP_ANNOTATIONS.has(x));
  if (keepAnn.length) {
    reasons.push(`注解 @${keepAnn.slice(0, 3).join(' @')} 运行时反向调用`);
    return { risk: 'keep', reasons };
  }
  if (opts.overrideIn > 0) {
    reasons.push('被实现/重写（OVERRIDE 入边），属于接口契约');
    return { risk: 'keep', reasons };
  }
  if (/Mapper$|Dao$/.test(parent) || /(^|\/)mapper\//i.test(file)) {
    reasons.push('MyBatis Mapper 方法，通常由 XML / 反射调用');
    return { risk: 'keep', reasons };
  }
  if (label === 'Field' || label === 'Variable') {
    if (decorators.length) {
      reasons.push(`带注解 @${decorators.slice(0, 2).join(' @')}`);
      return { risk: 'review', reasons, confidence: 'low' };
    }
    if (name === 'serialVersionUID') {
      reasons.push('序列化版本号常量');
      return { risk: 'keep', reasons, confidence: 'low' };
    }
    if (opts.writes > 0) {
      reasons.push('仅有写入、无读取，可能是遗留字段');
      return { risk: 'review', reasons, confidence: 'low' };
    }
    // 字段级引用在图谱里不完整：getter/setter、JSON 序列化、ORM 映射都不产生 USAGE 边。
    // 因此一律不判“低风险”，只提示人工确认。
    reasons.push('字段级引用不可靠（getter/setter、序列化、ORM 映射不入图），须人工确认');
    return { risk: 'review', reasons, confidence: 'low' };
  }
  if (label === 'Class' || label === 'Interface' || label === 'Enum') {
    if (opts.hasInherit) {
      reasons.push('被继承/实现');
      return { risk: 'keep', reasons };
    }
    if (STEREOTYPE_SUFFIX.test(name)) {
      reasons.push(`类名符合框架约定（${name.match(STEREOTYPE_SUFFIX)?.[0]}）`);
      return { risk: 'review', reasons };
    }
    if (decorators.length) {
      reasons.push(`带注解 @${decorators.slice(0, 2).join(' @')}`);
      return { risk: 'review', reasons };
    }
    if (FRAMEWORK_PATH.test(file)) {
      reasons.push('位于框架分层目录');
      return { risk: 'review', reasons };
    }
    if (opts.dynamic) {
      reasons.push('动态语言：反射 / 动态派发可能绕过静态图');
      return { risk: 'review', reasons };
    }
    reasons.push('无任何引用');
    return { risk: 'low', reasons };
  }

  // Method / Function
  if (opts.overrideOut > 0) {
    reasons.push('实现了接口/父类方法，需与契约一并评估');
    return { risk: 'review', reasons };
  }
  if (/^[A-Z]/.test(name) && /Mapper$/.test(parent)) {
    reasons.push('Mapper 接口方法');
    return { risk: 'keep', reasons };
  }
  if (/^(get|set|is)[A-Z]/.test(name)) {
    reasons.push('getter/setter，可能被序列化或反射调用');
    return { risk: 'review', reasons };
  }
  if (STEREOTYPE_SUFFIX.test(parent)) {
    reasons.push(`位于 ${parent}（框架组件）`);
    return { risk: 'review', reasons };
  }
  if (decorators.length) {
    reasons.push(`带注解 @${decorators.slice(0, 2).join(' @')}`);
    return { risk: 'review', reasons };
  }
  if (opts.dynamic) {
    reasons.push('动态语言：反射 / 装饰器 / 动态派发调用不入图，须人工确认');
    return { risk: 'review', reasons, confidence: 'low' };
  }
  reasons.push('无调用、无引用');
  return { risk: 'low', reasons };
}

const RISK_ORDER = { low: 0, review: 1, keep: 2 };

export function deadcode(h, opts = {}) {
  // 这个接口要扫全部节点并做入边判定，百万节点下是秒级起步，必须缓存（同参数重复访问直接命中）
  return cached(h, `deadcode:${JSON.stringify(opts)}`, () => deadcodeUncached(h, opts));
}

function deadcodeUncached(h, opts = {}) {
  const LABELS = ['Method', 'Function', 'Class', 'Interface', 'Enum', 'Field', 'Variable'];
  const ph = LABELS.map(() => '?').join(',');

  const nodes = h.all(
    `SELECT id, label, name, qualified_name, file_path, start_line, end_line, properties
     FROM nodes WHERE label IN (${ph})`,
    LABELS
  );

  // 入边：按 目标节点 + 类型 汇总
  // 目标不是可调用节点的 CALLS 边是索引器的误判（见文件头「可信调用边」口径），不能算“被引用”
  const inRows = h.all(
    `SELECT e.target_id AS id, e.type AS type, COUNT(*) AS n
     FROM edges e JOIN nodes t ON t.id = e.target_id
     WHERE t.label IN (${ph})
       AND NOT (e.type = 'CALLS' AND t.label NOT IN ('Method','Function'))
     GROUP BY e.target_id, e.type`,
    LABELS
  );
  const refs = new Map();
  for (const r of inRows) {
    const m = refs.get(r.id) ?? {};
    m[r.type] = r.n;
    refs.set(r.id, m);
  }

  /**
   * 接口派发闭包：实现方法的调用边其实落在接口/父类方法上
   * （OVERRIDE 方向是 实现方法 → 接口方法），纯看入边会把实现类方法误判成“无引用”。
   * 只要某条 OVERRIDE 的接口端被调用过，它的所有实现方法都算被引用。
   */
  const calledSuper = new Set();
  for (const [id, m] of refs) {
    if ((m.CALLS ?? 0) > 0 || (m.USAGE ?? 0) > 0) calledSuper.add(id);
  }
  const dispatched = new Set();
  for (const r of h.all(`SELECT source_id AS s, target_id AS t FROM edges WHERE type='OVERRIDE'`)) {
    if (calledSuper.has(r.t)) dispatched.add(r.s);
  }

  // 出边 OVERRIDE：该方法的实现关系（source = 实现方法）
  const overrideOut = new Map();
  for (const r of h.all(`SELECT source_id AS id, COUNT(*) AS n FROM edges WHERE type='OVERRIDE' GROUP BY source_id`)) {
    overrideOut.set(r.id, r.n);
  }

  const scanned = { Method: 0, Function: 0, Class: 0, Interface: 0, Enum: 0, Field: 0, Variable: 0 };
  const deadByKind = { Method: 0, Function: 0, Class: 0, Interface: 0, Enum: 0, Field: 0, Variable: 0 };
  const riskCount = { low: 0, review: 0, keep: 0 };
  const moduleMap = new Map();
  const fileMap = new Map();
  const rows = [];
  let reclaimLocLow = 0;
  let reclaimLocAll = 0;
  let testExcluded = 0;

  // 配置页上的排查规则（正则）：命中即整条排除，并单独统计命中次数便于校验规则
  const scanRules = rules();
  const excludeRules = scanRules.deadcodeRes;
  const rootPath = opts.rootPath || '';
  const annCache = new Map();
  let ruleExcluded = 0;
  const ruleHit = new Map();
  const excludedSamples = [];

  for (const n of nodes) {
    const d = props(n);
    const label = n.label;
    const file = n.file_path || '';
    if (!isScannableSource(file)) continue;
    // 测试代码不进主报表：它们本来就“无人调用”，混进来会淹没真实结论
    if (!!d.is_test || isTestPath(file)) {
      testExcluded += 1;
      continue;
    }
    // 排查规则：匹配类名 / 包名 / 全限定名 / 文件路径 / 注解（@Xxx，仅类级节点）
    if (excludeRules.length) {
      const isType = label === 'Class' || label === 'Interface' || label === 'Enum';
      const anns = [];
      if (isType) {
        anns.push(...decoratorsOf(d));
        if (scanRules.needsAnnotations && rootPath && file) {
          if (!annCache.has(file)) annCache.set(file, annotationsFromSource(path.join(rootPath, file)));
          anns.push(...annCache.get(file));
        }
      }
      // 分开匹配而不是拼成一个串：这样 ^com\. 之类的锚定写法才有意义
      const fields = [n.name, packageOf(file), n.qualified_name || '', file, ...anns.map((x) => `@${x}`)];
      const hit = excludeRules.find((r) => fields.some((f) => f && r.re.test(f)));
      if (hit) {
        ruleExcluded += 1;
        ruleHit.set(hit.source, (ruleHit.get(hit.source) ?? 0) + 1);
        if (excludedSamples.length < 30) {
          excludedSamples.push({ name: n.name, kind: label, file, line: n.start_line || 0, pattern: hit.source });
        }
        continue;
      }
    }
    const module = moduleOf(file);
    scanned[label] += 1;

    const m = refs.get(n.id) ?? {};
    const refTypes = REF_EDGES[label] ?? [];
    const used = refTypes.some((t) => (m[t] ?? 0) > 0) || dispatched.has(n.id);

    if (!moduleMap.has(module)) {
      moduleMap.set(module, {
        module,
        scanned: 0,
        methods: 0,
        classes: 0,
        fields: 0,
        deadMethods: 0,
        deadClasses: 0,
        deadFields: 0,
        low: 0,
        review: 0,
        keep: 0,
        loc: 0,
      });
    }
    const mod = moduleMap.get(module);
    mod.scanned += 1;
    if (label === 'Method' || label === 'Function') mod.methods += 1;
    else if (label === 'Field' || label === 'Variable') mod.fields += 1;
    else mod.classes += 1;

    if (used) continue;

    const startLine = n.start_line || 0;
    const endLine = n.end_line || 0;
    const loc = endLine >= startLine && startLine > 0 ? endLine - startLine + 1 : 1;

    const g = gradeNode(n, d, m, {
      isTest: !!d.is_test || isTestPath(file),
      isEntry: !!d.is_entry_point || !!d.route_path,
      overrideIn: m.OVERRIDE ?? 0,
      overrideOut: overrideOut.get(n.id) ?? 0,
      writes: m.WRITES ?? 0,
      hasInherit: (m.INHERITS ?? 0) + (m.IMPLEMENTS ?? 0) > 0,
      dynamic: DYNAMIC_LANG.test(file),
    });

    deadByKind[label] += 1;
    riskCount[g.risk] += 1;
    mod[g.risk] += 1;
    if (label === 'Method' || label === 'Function') {
      mod.deadMethods += 1;
      reclaimLocAll += loc;
      if (g.risk === 'low') reclaimLocLow += loc;
      mod.loc += g.risk === 'low' ? loc : 0;
    } else if (label === 'Field' || label === 'Variable') mod.deadFields += 1;
    else mod.deadClasses += 1;

    if (!fileMap.has(file)) fileMap.set(file, { file, module, dead: 0, low: 0, loc: 0 });
    const fm = fileMap.get(file);
    fm.dead += 1;
    if (g.risk === 'low') fm.low += 1;
    fm.loc += loc;

    rows.push({
      id: n.id,
      kind: label,
      name: n.name,
      qn: n.qualified_name || '',
      cls: d.parent_class ? String(d.parent_class).split('.').pop() : '',
      module,
      pkg: packageOf(file),
      file,
      line: startLine,
      endLine,
      loc,
      risk: g.risk,
      confidence: g.confidence ?? 'high',
      reasons: g.reasons,
      decorators: decoratorsOf(d),
      signature: d.signature ?? '',
      complexity: d.complexity ?? 0,
      lines: d.lines ?? loc,
      isTest: !!d.is_test,
    });
  }

  // 过滤
  const wantModule = opts.module ?? '';
  const wantKind = opts.kind ?? '';
  const wantRisk = opts.risk ?? '';
  const q = (opts.q ?? '').trim().toLowerCase();

  const filtered = rows.filter((r) => {
    if (wantModule && r.module !== wantModule) return false;
    if (wantKind && r.kind !== wantKind) return false;
    if (wantRisk && r.risk !== wantRisk) return false;
    if (q) {
      const hay = `${r.name} ${r.cls} ${r.file} ${r.kind}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const sort = opts.sort ?? 'loc';
  const cmp = {
    // 末位一律用 id 兜底：并列值（或浮点相同）时保证顺序唯一确定，翻页不会串行/漏项
    loc: (a, b) => b.loc - a.loc || b.lines - a.lines || a.id - b.id,
    complexity: (a, b) => b.complexity - a.complexity || a.id - b.id,
    name: (a, b) => String(a.name).localeCompare(String(b.name)) || a.id - b.id,
    module: (a, b) => a.module.localeCompare(b.module) || b.loc - a.loc || a.id - b.id,
    risk: (a, b) => RISK_ORDER[a.risk] - RISK_ORDER[b.risk] || b.loc - a.loc || a.id - b.id,
  }[sort] ?? ((a, b) => b.loc - a.loc);
  filtered.sort(cmp);

  const scannedAll = Object.values(scanned).reduce((a, b) => a + b, 0);

  /*
   * 分页：明细只在服务端切片，避免一次把上千行塞给浏览器。
   * all=1 用于导出 CSV，最多仍取 5000 条上限。
   */
  const total = filtered.length;
  const all = opts.all === true || opts.all === 1 || opts.all === '1';
  const pageSize = all ? Math.min(total, 5000) : Math.min(Math.max(Math.round(Number(opts.pageSize) || 50), 10), 500);
  const totalPages = all ? 1 : Math.max(1, Math.ceil(total / pageSize));
  const page = all ? 1 : Math.min(Math.max(Math.round(Number(opts.page) || 1), 1), totalPages);
  const from = all ? 0 : (page - 1) * pageSize;
  const rowsPage = all ? filtered.slice(0, Math.min(total, 5000)) : filtered.slice(from, from + pageSize);

  return {
    summary: {
      deadTotal: rows.length,
      scannedTotal: scannedAll,
      rate: scannedAll ? rows.length / scannedAll : 0,
      lowConfidence: rows.filter((r) => r.confidence === 'low').length,
      testExcluded,
      ruleExcluded,
      excludedByRule: [...ruleHit.entries()].map(([pattern, count]) => ({ pattern, count })).sort((a, b) => b.count - a.count),
      excludedSamples,
      byKind: Object.entries(scanned)
        .filter(([, n]) => n > 0)
        .map(([kind, n]) => ({ kind, scanned: n, dead: deadByKind[kind], rate: n ? deadByKind[kind] / n : 0 }))
        .sort((a, b) => b.dead - a.dead),
      byRisk: riskCount,
      reclaimLocLow,
      reclaimLocAll,
    },
    modules: [...moduleMap.values()].sort((a, b) => b.low - a.low || b.scanned - a.scanned),
    files: [...fileMap.values()].sort((a, b) => b.dead - a.dead || a.file.localeCompare(b.file)).slice(0, 15),
    rows: rowsPage,
    filtered: total,
    returned: rowsPage.length,
    truncated: all && total > rowsPage.length,
    page,
    pageSize,
    totalPages,
    from: rowsPage.length ? from + 1 : 0,
    to: from + rowsPage.length,
    applied: { module: wantModule, kind: wantKind, risk: wantRisk, q, sort, page: String(page), pageSize: String(pageSize) },
  };
}

export function graph(h, opts = {}) {
  const limit = opts.limit ?? 1200;
  const labels = opts.labels ?? ['Class', 'Interface', 'Enum', 'Module', 'Table', 'Route'];
  const ph = labels.map(() => '?').join(',');
  const nodes = h.all(`SELECT id, label, name, qualified_name, file_path, start_line, properties FROM nodes WHERE label IN (${ph}) LIMIT ?`, [...labels, limit]);
  const ids = new Set(nodes.map((n) => n.id));
  const edges = h
    .all(`SELECT source_id AS s, target_id AS t, type, properties FROM edges LIMIT ?`, [limit * 6])
    .filter((e) => ids.has(e.s) && ids.has(e.t));
  return {
    nodes: nodes.map((n) => ({ id: n.id, label: n.label, name: n.name, file: n.file_path || '', line: n.start_line || 0, module: moduleOf(n.file_path), ...props(n) })),
    edges,
    truncated: nodes.length >= limit,
  };
}
