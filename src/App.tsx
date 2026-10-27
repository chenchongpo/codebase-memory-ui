import { useCallback, useMemo, useState } from 'react';
import { useProjects, fmtInt, fmtBytes } from './api';
import { Icon, VIEWS, type NavPayload, type ViewId } from './lib/nav';
import { Badge } from './components/ui';

import { VIEW_REGISTRY } from './views/registry';

export default function App() {
  const { data, loading, error, reload } = useProjects();
  const [project, setProject] = useState<string>('');
  const [view, setView] = useState<ViewId>('overview');
  const [payload, setPayload] = useState<NavPayload | null>(null);
  const [token, setToken] = useState(0);

  const list = data?.projects ?? [];
  const current = list.find((p) => p.name === project) ?? list[0];

  const nav = useCallback((v: ViewId, p?: NavPayload) => {
    setToken((t) => t + 1);
    setView(v);
    setPayload(p ? { ...p, token: undefined } : null);
  }, []);

  const openSource = useCallback(
    (file: string, line?: number) => {
      setToken((t) => t + 1);
      setView('search');
      setPayload({ file, line: line ?? 1, token: token + 1 });
    },
    [token]
  );

  const meta = useMemo(() => VIEWS.find((v) => v.id === view)!, [view]);

  const selectProject = useCallback((name: string) => {
    setProject(name);
    setPayload(null);
  }, []);

  const props = {
    project: current?.name ?? '',
    nav,
    openSource,
    payload: payload ? { ...payload, token } : null,
    refresh: reload,
    selectProject,
  };

  // 视图注册表是唯一来源：新增视图只需改 registry.ts
  const ActiveView = VIEW_REGISTRY[view] ?? VIEW_REGISTRY.overview;

  if (loading) {
    return (
      <div className="center" style={{ height: '100%' }}>
        <div className="loading">正在连接 codebase-memory 图数据库…</div>
      </div>
    );
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-row">
            <div className="brand-mark">CI</div>
            <div>
              <div className="brand-name">Codebase Insight</div>
              <div className="brand-sub">codebase-memory-mcp</div>
            </div>
          </div>
          <select
            style={{ width: '100%', marginTop: 11 }}
            value={current?.name ?? ''}
            onChange={(e) => {
              setProject(e.target.value);
              setPayload(null);
            }}
          >
            {list.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name.split('.').slice(-2).join('.')}（{fmtInt(p.nodes)} 节点）
              </option>
            ))}
          </select>
        </div>

        <nav className="nav">
          {['代码体检', '结构视图', '工具'].map((group) => (
            <div key={group}>
              <div className="nav-group">{group}</div>
              {VIEWS.filter((v) => v.group === group).map((v) => (
                <button key={v.id} className={`nav-item ${view === v.id ? 'active' : ''}`} onClick={() => nav(v.id)}>
                  <Icon name={v.icon} />
                  <span>{v.label}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar-foot">
          {current && (
            <>
              <div className="kv">
                <span>节点 / 边</span>
                <span>{fmtInt(current.nodes)}/{fmtInt(current.edges)}</span>
              </div>
              <div className="kv">
                <span>库大小</span>
                <span>{fmtBytes(current.dbBytes)}</span>
              </div>
              <div className="kv">
                <span>索引时间</span>
                <span>{current.indexedAt.slice(0, 10)}</span>
              </div>
              <div style={{ marginTop: 8, color: current.rootExists ? 'var(--ok)' : 'var(--danger)' }}>
                {current.rootExists ? '● 源码目录可访问' : '● 源码目录不可访问'}
              </div>
            </>
          )}
          {data?.cacheDir && (
            <div style={{ marginTop: 6 }} className="mono tiny">
              {data.cacheDir}
            </div>
          )}
        </div>
      </aside>

      <main className="main">
        <div className="topbar">
          <div>
            <h1>{meta.title}</h1>
            <div className="sub">{meta.sub}</div>
          </div>
          <div className="topbar-right">
            {current && (
              <>
                <Badge tone="info">{current.name.split('.').slice(-2).join('.')}</Badge>
                <span className="tiny dim mono" title={current.rootPath}>
                  {current.rootPath}
                </span>
              </>
            )}
          </div>
        </div>

        <div className="content">
          {error && <div className="err">接口错误：<code>{error}</code></div>}
          {!list.length && !error && (
            <div className="err">
              还没有已索引的项目。点左侧「配置」→「代码索引」，选一个代码文件夹点「开始索引」；
              也可以继续用 codebase-memory-mcp 的 <code>index_repository</code>，图库默认落在 <code>D:\cbm-cache</code>。
            </div>
          )}
          {current && <ActiveView {...props} />}
        </div>
      </main>
    </div>
  );
}
