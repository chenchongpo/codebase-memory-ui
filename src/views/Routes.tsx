import { useState } from 'react';
import { apiGet, useApi, fmtInt } from '../api';
import type { Routes as RoutesData } from '../types';
import { Badge, Card, Donut, Empty, ErrorBox, HelpLink, Kpi, Loading, cxTone } from '../components/ui';
import { Pager } from '../components/Pager';
import { csvName, downloadCsv } from '../lib/csv';
import type { ViewProps } from '../lib/nav';

const METHOD_COLOR: Record<string, string> = {
  GET: '#3ddc97',
  POST: '#56b6ff',
  PUT: '#ffc857',
  DELETE: '#ff6b81',
  PATCH: '#a78bfa',
};

const SORTS = [
  { id: 'route', label: '按路径排序' },
  { id: 'complexity', label: '按复杂度排序' },
  { id: 'handler', label: '按处理器排序' },
  { id: 'module', label: '按模块排序' },
  { id: 'http', label: '按方法排序' },
];

export default function Routes({ project, nav, openSource }: ViewProps) {
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [mod, setMod] = useState('');
  const [http, setHttp] = useState('');
  const [sort, setSort] = useState('route');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  const { data, loading, error } = useApi<RoutesData>('/routes', {
    project,
    module: mod,
    http,
    q,
    sort,
    page,
    pageSize,
  });

  const withReset = (fn: () => void) => {
    setPage(1);
    fn();
  };

  const reset = () => {
    setQ('');
    setQInput('');
    setMod('');
    setHttp('');
    setSort('route');
    setPage(1);
  };

  if (!data) {
    if (error) return <ErrorBox msg={error} />;
    return <Loading text="正在整理接口面…" />;
  }

  const methods = Object.entries(data.httpMethods).sort((a, b) => b[1] - a[1]);
  const rows = data.rows;
  const active = q || mod || http || sort !== 'route';

  return (
    <>
      <div className="kpis">
        <Kpi k="路由总数" v={fmtInt(data.total)} color="var(--accent)" d="Route 类型节点" />
        <Kpi k="已绑定处理器" v={fmtInt(data.bound)} color="var(--accent-3)" d={`覆盖率 ${((data.bound / Math.max(1, data.total)) * 100).toFixed(1)}%`} />
        <Kpi k="未绑定" v={fmtInt(data.total - data.bound)} color="var(--warn)" d="无 HANDLES 边，可能是框架内部路由" />
        {methods.slice(0, 2).map(([m, n]) => (
          <Kpi key={m} k={`${m} 接口`} v={fmtInt(n)} color={METHOD_COLOR[m] ?? 'var(--accent-2)'} />
        ))}
      </div>

      <div className="grid c2">
        <Card title="HTTP 方法分布">
          <Donut
            center={data.total}
            slices={methods.map(([m, n]) => ({ label: m, value: n, color: METHOD_COLOR[m] ?? '#6b6b80' }))}
          />
        </Card>

        <Card title="按模块分布" help="点行可筛选下方明细。">
          <table className="tbl">
            <thead>
              <tr>
                <th>模块</th>
                <th className="num">接口数</th>
                <th className="num">平均复杂度</th>
                <th>最高复杂度接口</th>
              </tr>
            </thead>
            <tbody>
              {data.byModule
                .slice()
                .sort((a, b) => b.items.length - a.items.length)
                .map((g) => {
                  const worst = g.items.slice().sort((a, b) => b.complexity - a.complexity)[0];
                  return (
                    <tr key={g.module} style={{ cursor: 'pointer' }} onClick={() => withReset(() => setMod(mod === g.module ? '' : g.module))}>
                      <td className="mono">{g.module}</td>
                      <td className="num">{g.items.length}</td>
                      <td className="num dim">{(g.items.reduce((a, x) => a + x.complexity, 0) / g.items.length).toFixed(2)}</td>
                      <td className="mono tiny">
                        {worst?.handler} <Badge tone={cxTone(worst?.complexity ?? 0)}>{worst?.complexity}</Badge>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </Card>
      </div>

      <Card
        title="接口清单"
        hint={`共 ${fmtInt(data.filtered)} 条${loading ? ' · 更新中' : ''}`}
        help={
          <>
            未绑定 ≠ 坏接口：可能是框架内部路由、注解组合写法或索引未识别。
            <HelpLink onClick={() => nav('metrics', { query: 'api', token: Date.now() })}>接口口径</HelpLink>
          </>
        }
        right={
          <>
            <select value={mod} onChange={(e) => withReset(() => setMod(e.target.value))}>
              <option value="">全部模块</option>
              {data.byModule.map((g) => (
                <option key={g.module} value={g.module}>{g.module}</option>
              ))}
            </select>
            <select value={http} onChange={(e) => withReset(() => setHttp(e.target.value))}>
              <option value="">全部方法</option>
              {methods.map(([m]) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
            <select value={sort} onChange={(e) => withReset(() => setSort(e.target.value))}>
              {SORTS.map((s) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
            <input
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') withReset(() => setQ(qInput));
              }}
              placeholder="路径 / 处理器 / 类"
              style={{ width: 168 }}
            />
            <button className="btn sm" onClick={() => withReset(() => setQ(qInput))}>查询</button>
            {active && <button className="btn sm" onClick={reset}>重置</button>}
            <button
              className="btn sm"
              title="按当前筛选条件导出全量结果"
              onClick={() =>
                void exportCsv(project, { module: mod, http, q, sort }).catch((e: Error) =>
                  window.alert(`导出失败：${e.message}`)
                )
              }
            >
              导出 CSV
            </button>
          </>
        }
        bodyClass="tight"
      >
        {rows.length === 0 ? (
          <Empty text={active ? '当前筛选条件下没有命中' : '没有已绑定的接口'} />
        ) : (
          <>
            <div style={{ maxHeight: 620, overflow: 'auto' }}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th style={{ width: 52 }}>#</th>
                    <th style={{ width: 70 }}>方法</th>
                    <th>路径</th>
                    <th>处理器</th>
                    <th>所属类</th>
                    <th>模块</th>
                    <th className="num">复杂度</th>
                    <th className="num">行数</th>
                    <th>位置</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={`${r.route}-${i}`}>
                      <td className="num dim">{data.from + i}</td>
                      <td><span className={`method ${r.http}`}>{r.http}</span></td>
                      <td className="mono">{r.route}</td>
                      <td className="mono">{r.handler}</td>
                      <td className="mono dim">{r.cls || '—'}</td>
                      <td className="mono dim tiny">{r.module}</td>
                      <td className="num"><Badge tone={cxTone(r.complexity)}>{r.complexity}</Badge></td>
                      <td className="num dim">{r.lines}</td>
                      <td>
                        <span className="mono tiny" style={{ color: 'var(--accent)', cursor: 'pointer' }} onClick={() => openSource(r.file, r.line)} title={r.file}>
                          {r.file.split('/').slice(-2).join('/')}:{r.line}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <Pager meta={data} loading={loading} onPage={setPage} onPageSize={(n) => setPageSize(n)} />
          </>
        )}
      </Card>
    </>
  );
}

/** 按当前筛选条件取全量结果并导出 CSV */
async function exportCsv(
  project: string,
  filter: { module: string; http: string; q: string; sort: string }
) {
  const d = await apiGet<RoutesData>('/routes', { project, ...filter, all: 1 });
  downloadCsv(
    csvName('接口清单', project),
    ['HTTP 方法', '路径', '处理器', '所属类', '模块', '包', '文件', '起始行', '复杂度', '行数'],
    d.rows.map((r) => [r.http, r.route, r.handler, r.cls, r.module, r.pkg, r.file, r.line, r.complexity, r.lines])
  );
}
