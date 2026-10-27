/**
 * 配置层：本地 JSON 配置的读取、校验与持久化。
 *
 * 设计约束：
 *  - 只读磁盘一次并缓存，保存后立即生效（由调用方负责重连图数据库）；
 *  - 存储白名单化，未知字段一律丢弃，避免把随意 JSON 写回磁盘；
 *  - Token 对外只返回掩码，保存时收到掩码视为「保持不变」；
 *  - 环境变量优先级高于文件：CBM_ENDPOINT / CBM_TOKEN / CBM_CACHE_DIR。
 *
 * 本工程不含任何大模型调用：所有指标来自图数据库的确定性 SQL 聚合与规则引擎。
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './paths.mjs';

const CONFIG_FILE = path.join(CONFIG_DIR, 'app.config.json');

export const MASK = '••••••••';

export const DEFAULTS = {
  cbm: {
    /** 图数据库目录（*.db 所在目录） */
    cacheDir: '',
    /** 图表里记录的源码根路径失效时，用它映射到本机目录 */
    sourceRoot: '',
    /**
     * 索引服务的传输方式：
     *   http  —— MCP Streamable HTTP，POST JSON-RPC 到 endpoint（团队共享一台索引机时用）
     *   stdio —— 拉起本地 codebase-memory-mcp 进程，走 stdin/stdout（单机、离线时用）
     */
    transport: 'http',
    /** transport=http 时的端点地址 */
    endpoint: 'http://127.0.0.1:7801/mcp',
    /** transport=http 时的鉴权 Token（可选，发送为 Authorization: Bearer） */
    token: '',
    /** transport=stdio 时的可执行文件；留空则按常见安装位置自动探测 */
    exePath: '',
    /** transport=stdio 时的运行目录（守护进程 / 锁文件），留空用环境变量或默认值 */
    runtimeDir: '',
    /** 索引请求超时 */
    timeoutMs: 180000,
    /** 未指定 ?project= 时默认打开的项目 */
    defaultProject: '',
  },
  index: {
    /** 上次选择的代码库根路径（配置页「代码索引」用） */
    repoPath: '',
    /** full / moderate / fast */
    mode: 'full',
    /** 项目名覆盖，留空则按路径自动生成 */
    name: '',
    /** 上一次索引产出的项目名，方便一键跳转 */
    lastProject: '',
  },
  analysis: {
    /** 追加排除的目录名（内置已排除 node_modules/target/dist/build/out/vendor/.git） */
    excludeDirs: [],
    /** 追加的测试路径正则（字符串形式，逐条编译） */
    testPatterns: [],
    /** 无引用排查的排除规则（正则，逐行，大小写不敏感）。匹配对象：类名 / 全限定名 / 文件路径 / 注解（@Xxx） */
    deadcodeExclude: [],
  },
};

const str = (v, d = '') => (typeof v === 'string' ? v.trim() : d);
const MODES = ['full', 'moderate', 'fast'];
const num = (v, d, min, max) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return d;
  return Math.min(max, Math.max(min, n));
};
const arrStr = (v) =>
  Array.isArray(v)
    ? v.map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 50)
    : String(v ?? '')
        .split(/[\n,]/)
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, 50);

/** 白名单归一化：任何输入都收敛成完整、类型正确的配置对象 */
function normalize(raw = {}) {
  const cbm = raw.cbm && typeof raw.cbm === 'object' ? raw.cbm : {};
  const an = raw.analysis && typeof raw.analysis === 'object' ? raw.analysis : {};
  const idx = raw.index && typeof raw.index === 'object' ? raw.index : {};
  return {
    cbm: {
      cacheDir: str(cbm.cacheDir, DEFAULTS.cbm.cacheDir).replace(/[\\/]+$/, ''),
      sourceRoot: str(cbm.sourceRoot, DEFAULTS.cbm.sourceRoot).replace(/[\\/]+$/, ''),
      transport: cbm.transport === 'stdio' ? 'stdio' : 'http',
      endpoint: str(cbm.endpoint, DEFAULTS.cbm.endpoint).replace(/\/+$/, ''),
      token: str(cbm.token, ''),
      exePath: str(cbm.exePath, DEFAULTS.cbm.exePath),
      runtimeDir: str(cbm.runtimeDir, DEFAULTS.cbm.runtimeDir).replace(/[\\/]+$/, ''),
      timeoutMs: Math.round(num(cbm.timeoutMs, DEFAULTS.cbm.timeoutMs, 5000, 3600000)),
      defaultProject: str(cbm.defaultProject, DEFAULTS.cbm.defaultProject),
    },
    index: {
      repoPath: str(idx.repoPath, DEFAULTS.index.repoPath).replace(/[\\/]+$/, ''),
      mode: MODES.includes(idx.mode) ? idx.mode : DEFAULTS.index.mode,
      name: str(idx.name, DEFAULTS.index.name),
      lastProject: str(idx.lastProject, DEFAULTS.index.lastProject),
    },
    analysis: {
      excludeDirs: arrStr(an.excludeDirs),
      testPatterns: arrStr(an.testPatterns),
      deadcodeExclude: arrStr(an.deadcodeExclude),
    },
  };
}

let _cache = null;
let _rev = 0;

/** 当前配置（含真实 token，仅供服务端内部使用） */
export function getConfig() {
  if (_cache) return _cache;
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    raw = {};
  }
  _cache = normalize(raw);
  return _cache;
}

export function configRev() {
  return _rev;
}

export function configPath() {
  return CONFIG_FILE;
}

export function configExists() {
  return fs.existsSync(CONFIG_FILE);
}

/** 环境变量覆盖后的生效值 */
export function effective() {
  const c = getConfig();
  return {
    ...c,
    cbm: {
      ...c.cbm,
      cacheDir: process.env.CBM_CACHE_DIR?.trim() || c.cbm.cacheDir,
      endpoint: process.env.CBM_ENDPOINT?.trim() || c.cbm.endpoint,
      token: process.env.CBM_TOKEN?.trim() || c.cbm.token,
      exePath: process.env.CBM_EXE?.trim() || c.cbm.exePath,
      runtimeDir: process.env.CBM_RUNTIME_DIR?.trim() || c.cbm.runtimeDir,
    },
  };
}

/** 对外输出：token 打码，附带来源标记 */
export function publicConfig() {
  const eff = effective();
  return {
    cbm: { ...eff.cbm, token: eff.cbm.token ? MASK : '', tokenSet: !!eff.cbm.token },
    analysis: eff.analysis,
    index: eff.index,
    meta: {
      configPath: CONFIG_FILE,
      exists: configExists(),
      cacheDirFromEnv: !!process.env.CBM_CACHE_DIR?.trim(),
      endpointFromEnv: !!process.env.CBM_ENDPOINT?.trim(),
      tokenFromEnv: !!process.env.CBM_TOKEN?.trim(),
      defaults: DEFAULTS,
      /** 非法正则：保存时被忽略，配置页据此提示 */
      invalidPatterns: rules().invalidPatterns,
    },
  };
}

/** 合并保存：patch 中缺省的字段保持原值；token 收到掩码表示不变，空串表示清除 */
export function saveConfig(patch = {}) {
  const cur = getConfig();
  const merged = {
    cbm: { ...cur.cbm, ...(patch.cbm ?? {}) },
    analysis: { ...cur.analysis, ...(patch.analysis ?? {}) },
    index: { ...cur.index, ...(patch.index ?? {}) },
  };
  if (patch.cbm) {
    if (patch.cbm.token === MASK || patch.cbm.token === undefined) merged.cbm.token = cur.cbm.token;
    else if (patch.cbm.token === '') merged.cbm.token = '';
  }
  // 编辑口径时允许整体替换数组（前端传空数组 = 清空追加规则）
  if (patch.analysis && Array.isArray(patch.analysis.excludeDirs)) merged.analysis.excludeDirs = patch.analysis.excludeDirs;
  if (patch.analysis && Array.isArray(patch.analysis.testPatterns)) merged.analysis.testPatterns = patch.analysis.testPatterns;
  if (patch.analysis && Array.isArray(patch.analysis.deadcodeExclude)) merged.analysis.deadcodeExclude = patch.analysis.deadcodeExclude;

  const next = normalize(merged);
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, CONFIG_FILE);
  _cache = next;
  _rev += 1;
  return publicConfig();
}

export function resetConfigCache() {
  _cache = null;
  _rev += 1;
}

/** 由配置派生的扫描规则（编译一次，配置变更后重建） */
let _ruleRev = -1;
let _rules = { excludeRes: [], testRes: [], deadcodeRes: [], invalidPatterns: [], needsAnnotations: false };

export function rules() {
  if (_ruleRev === configRev()) return _rules;
  const an = getConfig().analysis;
  const invalidPatterns = [];

  /** 逐条编译；非法正则不抛错，只记入 invalidPatterns 供配置页提示 */
  const compile = (list, field) =>
    list.flatMap((p) => {
      try {
        return [{ source: p, re: new RegExp(p, 'i') }];
      } catch {
        invalidPatterns.push({ field, pattern: p });
        return [];
      }
    });

  const testRes = compile(an.testPatterns, 'testPatterns').map((x) => x.re);
  const deadcodeRes = compile(an.deadcodeExclude, 'deadcodeExclude');
  const excludeRes = an.excludeDirs.map(
    (d) => new RegExp(`(^|/)${d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(/|$)`, 'i')
  );
  _rules = {
    excludeRes,
    testRes,
    deadcodeRes,
    invalidPatterns,
    /** 规则里出现 @ 才需要去源码补注解，避免无谓的文件读取 */
    needsAnnotations: deadcodeRes.some((r) => r.source.includes('@')),
  };
  _ruleRev = configRev();
  return _rules;
}
