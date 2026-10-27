/**
 * 目录浏览：给配置页的「选择代码文件夹」用。
 *
 * 只读、只列一层，不递归；重目录（node_modules / target / .git …）默认不展开，
 * 但仍会在标记里标出当前目录是不是一个代码仓库。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 代码仓库的典型标记文件 / 目录，命中任意一个就认为「像个仓库」 */
const MARKERS = [
  '.git',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
  'package.json',
  'tsconfig.json',
  'go.mod',
  'Cargo.toml',
  'pyproject.toml',
  'setup.py',
  'requirements.txt',
  'composer.json',
  'Gemfile',
  'CMakeLists.txt',
  'Makefile',
  'WORKSPACE',
  '.svn',
];

/** 这些目录体积大且几乎不可能是「代码库根」，列表里默认隐藏（用 showHeavy=1 可展开） */
const HEAVY = new Set([
  'node_modules', 'bower_components', 'target', 'dist', 'build', 'out', 'vendor',
  'bin', 'obj', '.git', '.svn', '.hg', '.idea', '.gradle', '.mvn', '.vs',
  '__pycache__', '.venv', 'venv', '.mypy_cache', '.pytest_cache', '.next', '.nuxt',
  'coverage', '.cache',
]);

const MAX_ENTRIES = 400;

function markersOf(dir) {
  const hit = [];
  for (const m of MARKERS) {
    try {
      if (fs.existsSync(path.join(dir, m))) hit.push(m);
    } catch {
      /* ignore */
    }
  }
  // .NET 解决方案：任意 *.sln
  try {
    const sln = fs.readdirSync(dir).find((f) => f.toLowerCase().endsWith('.sln'));
    if (sln) hit.push(sln);
  } catch {
    /* ignore */
  }
  return hit;
}

/** Windows 下先列盘符，其它平台从 / 起 */
function roots() {
  if (process.platform === 'win32') {
    const drives = [];
    for (let c = 67; c <= 90; c += 1) {
      const d = `${String.fromCharCode(c)}:\\`;
      try {
        if (fs.existsSync(d)) drives.push({ name: `${String.fromCharCode(c)}:`, path: d, markers: [], heavy: false });
      } catch {
        /* ignore */
      }
    }
    return { path: '', parent: '', isRoot: true, rootMode: true, currentMarkers: [], entries: drives, truncated: false, hidden: 0 };
  }
  return { path: '/', parent: '', isRoot: true, rootMode: false, currentMarkers: markersOf('/'), entries: subdirs('/', false), truncated: false, hidden: 0 };
}

function subdirs(dir, showHeavy) {
  let names;
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  let hidden = 0;
  for (const d of names) {
    if (!d.isDirectory()) continue;
    if (HEAVY.has(d.name)) {
      if (!showHeavy) {
        hidden += 1;
        continue;
      }
    }
    if (d.name.startsWith('$') || d.name === 'System Volume Information' || d.name === 'RECYCLE.BIN') continue;
    out.push({
      name: d.name,
      path: path.join(dir, d.name),
      markers: [],
      heavy: HEAVY.has(d.name),
    });
  }
  return { list: out, hidden };
}

/** 列一层目录；path 为空表示列盘符 / 根 */
export function listDir(input, opts = {}) {
  const want = String(input ?? '').trim();
  if (!want) return roots();

  const target = path.resolve(want);
  let st;
  try {
    st = fs.statSync(target);
  } catch (err) {
    return { path: target, parent: path.dirname(target), isRoot: false, error: err.code === 'ENOENT' ? '目录不存在' : String(err.message ?? err), entries: [], currentMarkers: [], truncated: false, hidden: 0 };
  }
  if (!st.isDirectory()) {
    return { path: target, parent: path.dirname(target), isRoot: false, error: '该路径不是目录', entries: [], currentMarkers: [], truncated: false, hidden: 0 };
  }

  const raw = subdirs(target, !!opts.showHeavy);
  const entries = Array.isArray(raw) ? raw : raw.list;
  const hidden = Array.isArray(raw) ? 0 : raw.hidden;

  // 给每个子目录打上仓库标记（只做存在性探测，成本很低），并按「像不像代码库」排序
  for (const e of entries) e.markers = markersOf(e.path);
  entries.sort((a, b) => {
    const sa = a.markers.length > 0 ? 0 : a.heavy ? 2 : 1;
    const sb = b.markers.length > 0 ? 0 : b.heavy ? 2 : 1;
    if (sa !== sb) return sa - sb;
    return a.name.localeCompare(b.name, 'zh-CN');
  });

  const truncated = entries.length > MAX_ENTRIES;
  const parent = path.dirname(target);
  return {
    path: target,
    parent: parent === target ? '' : parent,
    isRoot: parent === target,
    rootMode: false,
    currentMarkers: markersOf(target),
    entries: truncated ? entries.slice(0, MAX_ENTRIES) : entries,
    truncated,
    hidden,
  };
}
