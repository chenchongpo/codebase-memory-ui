/** 与 server/queries.mjs 返回结构对应的类型定义 */

export interface ProjectInfo {
  name: string;
  rootPath: string;
  indexedAt: string;
  dbPath: string;
  dbBytes: number;
  nodes: number;
  edges: number;
  rootExists: boolean;
}

export interface LabelCount { label: string; n: number }
export interface TypeCount { type: string; n: number }

export interface ModuleStat {
  name: string;
  count: number;
  avgCx: number;
  maxCx: number;
  lines: number;
  files: number;
}

export interface Overview {
  project: { name: string; rootPath: string; indexedAt: string; branch: string; headSha: string; isGit: boolean };
  totals: {
    nodes: number; edges: number; files: number; folders: number; classes: number;
    methods: number; routes: number; variables: number; indexedLoc: number;
  };
  labels: LabelCount[];
  edgeTypes: TypeCount[];
  metrics: {
    avgComplexity: number; maxComplexity: number; p50: number; p90: number; p99: number;
    avgLines: number; avgCognitive: number; entryPoints: number; testMethods: number;
    hotSpots: number;
  };
  modules: ModuleStat[];
  topMethods: { name: string; cls: string; module: string; complexity: number; lines: number; cog: number; file: string; line: number }[];
  coverage: { kind: string; n: number }[];
  summary: string;
}

export interface ScatterPoint { x: number; y: number; z: number; cog: number; n: string; c: string; f: string; l: number; t: boolean }

/** 服务端分页元信息（各明细表通用） */
export interface PagedMeta {
  /** 命中筛选条件的总条数 */
  filtered: number;
  /** 本次返回条数 */
  returned: number;
  /** 导出时超过 5000 条会置真 */
  truncated: boolean;
  page: number;
  pageSize: number;
  totalPages: number;
  /** 本次返回的首条序号（1 基，空结果时为 0） */
  from: number;
  to: number;
}

export interface ComplexityRow {
  id: number; kind: string; name: string; cls: string; module: string; pkg: string;
  file: string; line: number; endLine: number;
  complexity: number; cognitive: number; lines: number; loopDepth: number; loopCount: number;
  paramCount: number; isEntry: boolean; isTest: boolean; signature: string; doc: string;
}

export interface ComplexityData extends PagedMeta {
  hist: Record<string, number>;
  scatter: ScatterPoint[];
  rows: ComplexityRow[];
  modules: { module: string; buckets: Record<string, number>; total: number; maxCx: number; lines: number }[];
  quantiles: { p50: number; p75: number; p90: number; p95: number; p99: number; max: number };
  total: number;
  applied: { module: string; bucket: string; kind: string; q: string; sort: string; test: string; page: string; pageSize: string };
}

export interface DupMember {
  id: number; name: string; label: string; file: string; line: number;
  lines: number; complexity: number; cls: string;
}
export interface DupCluster { size: number; jaccard: number; crossFile: boolean; loc: number; members: DupMember[] }
export interface FpGroup { fp: string; size: number; loc: number; members: { id: number; name: string; file: string; line: number; lines: number; complexity: number }[] }
export interface Duplicates {
  clusters: DupCluster[];
  fingerprints: FpGroup[];
  stats: { edgeCount: number; clusterCount: number; dupMethods: number; reclaimLoc: number; fpGroups: number; fpReclaimLoc: number };
}

export interface ArchModule { name: string; files: number; pkgs: number; loc: number; changes: number; methods: number; avgCx: number }
export interface ArchNode { id: string; label: string; full: string; module: string; files: number; loc: number }
export interface ArchEdge { s: string; t: string; w: number }
export interface TreeNode { name: string; path: string; loc: number; files: number; children: TreeNode[] }

export interface Architecture {
  modules: ArchModule[];
  moduleEdges: ArchEdge[];
  packageNodes: ArchNode[];
  packageEdges: ArchEdge[];
  tree: TreeNode[];
  fileCount: number;
  totalLoc: number;
  extStats: { ext: string; n: number }[];
}

export interface LayerNode {
  id: string; label: string; hint: string; files: number; methods: number;
  lines: number; cx: number; maxCx: number; hotCx: number; avgCx: number; loc: number;
}
export interface Layers { nodes: LayerNode[]; flows: ArchEdge[]; externalEntries: number }

export interface RouteItem {
  route: string; http: string; handler: string; cls: string; file: string;
  line: number; complexity: number; lines: number; module: string; pkg: string;
}
export interface Routes extends PagedMeta {
  rows: RouteItem[];
  byModule: { module: string; items: RouteItem[] }[];
  httpMethods: Record<string, number>;
  total: number;
  bound: number;
  applied: { module: string; http: string; q: string; sort: string; page: string; pageSize: string };
}

/* --------------------------------------------------------- 调用链路图 */

export type ChainDir = 'up' | 'down';

/**
 * 这一跳的解析溯源。索引器只有语法、没有完整类型环境，部分调用是靠名字猜的，
 * 猜错的方向往往是「把 JDK / 三方库调用错接到项目内同名方法上」。
 * 本字段把这层不确定性显式带到界面上，由用户核对，而不是按阈值过滤掉。
 */
export type ChainViaKind = 'exact' | 'inferred' | 'suspect';

export interface ChainVia {
  kind: ChainViaKind;
  /** 索引器给出的解析策略，如 lsp_type_dispatch / unique_name / suffix_match */
  strategy: string;
  /** 源码里写的调用形式，如 getSeq / targetDataSources.put */
  callee: string;
  /** 后缀匹配时的候选数量 */
  candidates: number;
  /** 被调方法名命中常见 JDK / 库方法名，高度怀疑是外部调用被错接 */
  external: boolean;
}

export interface ChainStep {
  id: number;
  name: string;
  label: string;
  cls: string;
  file: string;
  line: number;
  /** 在本节点内发起对下一跳调用的行号；末端为 0 */
  callLine: number;
  isEntry: boolean;
  /** 通过接口/实现派发到达（OVERRIDE 边，不是 CALLS 边） */
  virtual: boolean;
  /** 到达本节点这一跳的解析溯源；根节点与派发跳为 null */
  via: ChainVia | null;
}
export interface CallChain {
  hops: number;
  /** 是否因深度上限被截断 */
  cut: boolean;
  /** 链路起点是否入口 */
  entry: boolean;
  /** 本链中被标红的跳数（suspect） */
  suspect: number;
  /** 本链中靠唯一同名推断的跳数（inferred） */
  inferred: number;
  steps: ChainStep[];
}

export interface ChainNeighbor {
  id: number;
  name: string;
  cls: string;
  label: string;
  file: string;
  line: number;
  calls: number;
  isEntry: boolean;
  /** 需要经过接口/实现派发才够得着 */
  viaDispatch: boolean;
}

export interface ChainStats {
  matched: number;
  targets: number;
  directCallers: number;
  directCallees: number;
  chains: number;
  truncated: boolean;
  orphanTargets: number;
  leafTargets: number;
  cutChains: number;
  indirectChains: number;
  rootEntries: number;
  maxHops: number;
  edgeCount: number;
  /**
   * 本次链路**实际遍历到**的调用边的解析溯源分布（exact/inferred/suspect）。
   * 注意是「本次遍历」而非全库：全库分布要扫数百万条边，百万节点下不划算。
   */
  viaHops: Record<ChainViaKind, number>;
  /** 含被标红跳的链数 */
  suspectChains: number;
  /** 当前返回的链里被标红 / 推断的总跳数 */
  suspectHops: number;
  inferredHops: number;
}

export interface CallChains {
  query: string;
  dir: ChainDir;
  mode: 'class' | 'package' | 'method' | 'name' | 'picked' | 'none';
  depth: number;
  matched: { id: number; name: string; label: string; file: string; line: number; pkg: string }[];
  chains: CallChain[];
  directCallers: ChainNeighbor[];
  directCallees: ChainNeighbor[];
  suggest: string[];
  stats: ChainStats;
}

/** 起点选择器的一行：模块 / 子包 / 类 / 方法 */
export type BrowseLevel = 'module' | 'package' | 'class' | 'method';

export interface BrowseRow {
  level: BrowseLevel;
  key: string;
  name: string;
  kind: string;
  sub: string;
  count: number;
  hasChildren: boolean;
  id?: number;
  cls?: string;
  file?: string;
  line?: number;
  members?: number;
  complexity?: number;
  inCalls?: number;
  outCalls?: number;
}

export interface BrowseData extends PagedMeta {
  level: BrowseLevel;
  /** 当前范围：模块名 / 包名 / 类 */
  scope: { module: string; pkg: string; classId: number; className: string; classFile: string };
  /** 该模块折叠后的包名前缀（面包屑从这里起步） */
  base: string;
  rows: BrowseRow[];
  applied: { q: string };
}

export interface Coverage {
  kinds: { kind: string; label: string; count: number; items: { rel_path: string; kind: string; detail: string }[] }[];
  stats: { fileHashes: number; lspSurfaces: number; nodes: number; ftsRows: number };
  meta: { k: string; v: string }[];
}

export interface SearchHit {
  id: number; label: string; name: string; qn: string; file: string; line: number;
  endLine: number; complexity: number | null; lines: number | null; cls: string; doc: string;
}

export interface NodeDetail {
  node: { id: number; label: string; name: string; qn: string; file: string; startLine: number; endLine: number; props: Record<string, unknown> };
  outgoing: { type: string; id: number; label: string; name: string; file: string; line: number }[];
  incoming: { type: string; id: number; label: string; name: string; file: string; line: number }[];
}

export interface Snippet { path: string; totalLines: number; start: number; end: number; lines: { n: number; t: string }[] }

/* ---------------------------------------------------------- 无引用代码报表 */

export type DeadRisk = 'low' | 'review' | 'keep';

export interface DeadRow {
  id: number;
  kind: string;
  name: string;
  qn: string;
  cls: string;
  module: string;
  pkg: string;
  file: string;
  line: number;
  endLine: number;
  loc: number;
  risk: DeadRisk;
  confidence: 'high' | 'low';
  reasons: string[];
  decorators: string[];
  signature: string;
  complexity: number;
  lines: number;
  isTest: boolean;
}

export interface DeadModule {
  module: string;
  scanned: number;
  methods: number;
  classes: number;
  fields: number;
  deadMethods: number;
  deadClasses: number;
  deadFields: number;
  low: number;
  review: number;
  keep: number;
  loc: number;
}

export interface DeadCodeData {
  summary: {
    deadTotal: number;
    scannedTotal: number;
    rate: number;
    lowConfidence: number;
    testExcluded: number;
    ruleExcluded: number;
    excludedByRule: { pattern: string; count: number }[];
    excludedSamples: { name: string; kind: string; file: string; line: number; pattern: string }[];
    byKind: { kind: string; scanned: number; dead: number; rate: number }[];
    byRisk: { low: number; review: number; keep: number };
    reclaimLocLow: number;
    reclaimLocAll: number;
  };
  modules: DeadModule[];
  files: { file: string; module: string; dead: number; low: number; loc: number }[];
  rows: DeadRow[];
  filtered: number;
  returned: number;
  truncated: boolean;
  page: number;
  pageSize: number;
  totalPages: number;
  from: number;
  to: number;
  applied: { module: string; kind: string; risk: string; q: string; sort: string; page: string; pageSize: string };
}

/* --------------------------------------------------------------- 配置 */

/** 索引服务的传输方式：http（MCP Streamable HTTP）/ stdio（本地子进程） */
export type McpTransport = 'http' | 'stdio';

export interface CbmConfig {
  cacheDir: string;
  sourceRoot: string;
  transport: McpTransport;
  /** transport=http 时的端点地址 */
  endpoint: string;
  /** 对外只返回掩码；保存时原样回传表示「不修改」 */
  token: string;
  tokenSet: boolean;
  /** transport=stdio 时的可执行文件路径，留空自动探测 */
  exePath: string;
  runtimeDir: string;
  timeoutMs: number;
  defaultProject: string;
}

export interface AppConfig {
  cbm: CbmConfig;
  analysis: { excludeDirs: string[]; testPatterns: string[]; deadcodeExclude: string[] };
  index: IndexConfig;
  meta: {
    configPath: string;
    exists: boolean;
    cacheDirFromEnv: boolean;
    endpointFromEnv: boolean;
    tokenFromEnv: boolean;
    invalidPatterns: { field: string; pattern: string }[];
    defaults: {
      cbm: CbmConfig;
      analysis: AppConfig['analysis'];
      index: IndexConfig;
    };
  };
  savedAt?: string;
}

/* ------------------------------------------------------- 代码索引（MCP） */

export type IndexMode = 'full' | 'moderate' | 'fast';

export interface IndexConfig {
  repoPath: string;
  mode: IndexMode;
  name: string;
  lastProject: string;
}

export interface IndexLogEntry {
  t: string;
  level: 'info' | 'stage' | 'ok' | 'warn' | 'error' | 'mcp' | 'progress';
  text: string;
}

export interface IndexStatus {
  id: number;
  state: 'idle' | 'running' | 'done' | 'failed' | 'canceled';
  stage: string;
  repoPath: string;
  mode: string;
  name: string;
  project: string;
  elapsedMs: number;
  startedAt: string;
  finishedAt: string;
  error: string;
  result: {
    project: string;
    nodes: number;
    edges: number;
    rootPath: string;
    dbPath: string;
    dbBytes: number;
    mode: string;
    parseMs: number;
  } | null;
  log: IndexLogEntry[];
  logTotal: number;
}

export interface FsEntry {
  name: string;
  path: string;
  /** pom.xml / .git / package.json … 命中即认为像个代码仓库 */
  markers: string[];
  heavy: boolean;
}

export interface FsList {
  path: string;
  parent: string;
  isRoot: boolean;
  /** 空路径时列的是盘符 */
  rootMode: boolean;
  currentMarkers: string[];
  entries: FsEntry[];
  truncated: boolean;
  hidden: number;
  error?: string;
}

/** 索引服务探测结果（按配置的传输方式返回不同字段） */
export interface ServiceProbe {
  ok: boolean;
  transport: McpTransport;
  name?: string;
  version?: string;
  tools?: string[];
  endpoint?: string;
  exe?: string;
  error?: string;
}

export interface McpStatus {
  transport: McpTransport;
  endpoint: string;
  tokenSet: boolean;
  exePath: string;
  cacheDir: string;
  probe: ServiceProbe;
  running: boolean;
}

export interface ProbeResult {
  path: string;
  kind: 'dir' | 'file';
  exists: boolean;
  isDir: boolean;
  dbCount: number;
  databases: { file: string; bytes: number }[];
  error: string | null;
}
