import { useState } from 'react';
import { useApi, fmtInt } from '../api';
import type { ComplexityData, Overview as OverviewData } from '../types';
import { Badge, Card, CX_COLOR, CX_LABEL, CX_ORDER, Donut, Empty, ErrorBox, HBars, HelpLink, Histogram, Kpi, Loading, cxTone } from '../components/ui';
import type { ViewProps } from '../lib/nav';

export default function Overview({ project, nav, openSource }: ViewProps) {
  const ov = useApi<OverviewData>('/overview', { project });
  const cx = useApi<ComplexityData>('/complexity', { project, slim: 1 });
  const [distTab, setDistTab] = useState<'node' | 'edge'>('node');

  if (ov.loading || cx.loading) return <Loading text="正在读取图数据库…" />;
  if (ov.error) return <ErrorBox msg={ov.error} />;
  if (!ov.data) return <Empty text="暂无数据" />;

  const d = ov.data;
  const c = cx.data;
  const t = d.totals;
  const m = d.metrics;
  const hist = c?.hist ?? { '1-5': 0 };
  const histTotal = Object.values(hist).reduce((a, b) => a + b, 0);
  const coverageMap = Object.fromEntries(d.coverage.map((x) => [x.kind, x.n]));
  const covTotal = d.coverage.reduce((a, x) => a + x.n, 0);

  return (
    <>
      <div className="kpis">
        <Kpi k="已索引文件" v={fmtInt(t.files)} color="var(--accent)" d={`${fmtInt(t.folders)} 个目录`} />
        <Kpi k="类型 / 接口 / 枚举" v={fmtInt(t.classes)} color="var(--accent-2)" d={`${fmtInt(t.variables)} 个字段与变量`} />
        <Kpi k="函数 / 方法" v={fmtInt(t.methods)} color="var(--accent-3)" d={`平均 ${m.avgComplexity} 复杂度`} />
        <Kpi k="代码行数" v={fmtInt(t.indexedLoc)} color="var(--cx2)" d="函数体合计（AST 口径）" />
        <Kpi k="接口路由" v={fmtInt(t.routes)} color="var(--warn)" d={`${fmtInt(m.entryPoints)} 个标记入口`} />
        <Kpi k="最大复杂度" v={fmtInt(m.maxComplexity)} color="var(--danger)" d={`P90 = ${m.p90} · P99 = ${m.p99}`} />
        <Kpi k="高复杂度函数" v={fmtInt(m.hotSpots)} color="var(--crit)" d={`圈复杂度 > 10 · 占比 ${((m.hotSpots / Math.max(1, t.methods)) * 100).toFixed(1)}%`} />
      </div>

      <div className="grid c2" style={{ marginTop: 14 }}>
        <Card title="函数复杂度分布" right={<Badge tone="info">{fmtInt(histTotal)} 个函数</Badge>}>
          <Histogram
            data={CX_ORDER.map((k) => ({ key: k, label: CX_LABEL[k], value: hist[k] ?? 0 }))}
            colors={CX_COLOR}
            onPick={() => nav('complexity')}
          />
        </Card>

        <Card title="关键指标">
          <div className="grid c2" style={{ gap: 10 }}>
            <Kpi k="平均圈复杂度" v={m.avgComplexity} color="var(--cx1)" />
            <Kpi k="平均认知复杂度" v={m.avgCognitive} color="var(--cx2)" />
            <Kpi k="平均函数行数" v={m.avgLines} color="var(--cx3)" />
            <Kpi k="P90 复杂度" v={m.p90} color="var(--cx4)" />
          </div>
        </Card>
      </div>

      <div className="grid c2">
        <Card title="各模块复杂度构成" help="堆叠段 = 各复杂度档的函数数；点行进入该模块的复杂度明细。">
          <div style={{ display: 'grid', gap: 9 }}>
            {(c?.modules ?? []).map((mod) => {
              const max = Math.max(1, ...(c?.modules ?? []).map((x) => x.total));
              return (
                <div key={mod.module} onClick={() => nav('complexity', { module: mod.module })} style={{ cursor: 'pointer' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, marginBottom: 3 }}>
                    <span className="mono" style={{ color: 'var(--fg-mid)' }}>{mod.module}</span>
                    <span className="mono" style={{ color: 'var(--fg-dim)' }}>
                      {mod.total} 函数 · 最高 {mod.maxCx} · {mod.lines.toLocaleString()} 行
                    </span>
                  </div>
                  <div style={{ display: 'flex', height: 12, borderRadius: 4, overflow: 'hidden', background: 'var(--panel-3)', width: `${(mod.total / max) * 100}%`, minWidth: 40 }}>
                    {CX_ORDER.map((k) =>
                      mod.buckets[k] ? (
                        <div key={k} title={`${CX_LABEL[k]}: ${mod.buckets[k]}`} style={{ width: `${(mod.buckets[k] / mod.total) * 100}%`, background: CX_COLOR[k], opacity: 0.9 }} />
                      ) : null
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        <Card title="最复杂的函数" right={<button className="btn sm" onClick={() => nav('complexity')}>查看全部</button>}>
          <table className="tbl">
            <thead>
              <tr>
                <th>函数</th>
                <th>所属类</th>
                <th className="num">复杂度</th>
                <th className="num">行数</th>
                <th>位置</th>
              </tr>
            </thead>
            <tbody>
              {d.topMethods.map((x, i) => (
                <tr key={`${x.file}:${x.line}:${i}`}>
                  <td className="mono">{x.name}</td>
                  <td className="mono dim">{x.cls || '—'}</td>
                  <td className="num"><Badge tone={cxTone(x.complexity)}>{x.complexity}</Badge></td>
                  <td className="num dim">{x.lines}</td>
                  <td>
                    <span className="mono tiny" style={{ color: 'var(--accent)', cursor: 'pointer' }} onClick={() => openSource(x.file, x.line)} title={x.file}>
                      {x.file.split('/').slice(-2).join('/')}:{x.line}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>

      <div className="grid c2">
        <Card
          title={distTab === 'node' ? '节点类型分布' : '边类型分布'}
          help={
            <>
              {distTab === 'node'
                ? '节点类型 = 代码实体（类 / 方法 / 路由 / 文件…）。'
                : '边类型 = 关系（CALLS、IMPORTS、USAGE…）；调用类结论以 CALLS 为准。'}
              <HelpLink onClick={() => nav('metrics', { query: 'node-edge', token: Date.now() })}>节点与边口径</HelpLink>
            </>
          }
          right={
            <div className="seg">
              <button className={distTab === 'node' ? 'on' : ''} onClick={() => setDistTab('node')}>
                节点 {fmtInt(d.labels.length)} 类
              </button>
              <button className={distTab === 'edge' ? 'on' : ''} onClick={() => setDistTab('edge')}>
                边 {fmtInt(d.edgeTypes.length)} 类
              </button>
            </div>
          }
        >
          {distTab === 'node' ? (
            <HBars rows={d.labels.slice(0, 12).map((l) => ({ key: l.label, label: l.label, value: l.n, color: 'var(--accent-2)' }))} />
          ) : (
            <HBars rows={d.edgeTypes.slice(0, 12).map((e) => ({ key: e.type, label: e.type, value: e.n, color: 'var(--accent-3)' }))} />
          )}
        </Card>

        <Card title="索引覆盖率" help="解析质量自检：这些文件/目录没有被完全解析，涉及它们的复杂度与依赖统计会偏乐观。">
          {covTotal === 0 ? (
            <Empty text="全部文件解析成功，无遗漏" />
          ) : (
            <>
              <Donut
                center={covTotal}
                slices={[
                  { label: '未索引目录', value: coverageMap.not_indexed_dir ?? 0, color: 'var(--warn)' },
                  { label: '未索引文件', value: coverageMap.not_indexed_file ?? 0, color: 'var(--danger)' },
                  { label: '部分解析失败', value: coverageMap.parse_partial ?? 0, color: 'var(--cx4)' },
                ]}
              />
            </>
          )}
        </Card>
      </div>

      <Card title="项目元信息">
        <table className="tbl">
          <tbody>
            <tr><td className="dim">项目名</td><td className="mono">{d.project.name}</td></tr>
            <tr><td className="dim">源码根目录</td><td className="mono wrap">{d.project.rootPath}</td></tr>
            <tr><td className="dim">索引时间</td><td className="mono">{d.project.indexedAt}</td></tr>
            <tr><td className="dim">Git 分支</td><td className="mono">{d.project.branch || '—'} <span className="dim">{d.project.headSha}</span></td></tr>
            <tr><td className="dim">节点 / 边</td><td className="mono">{fmtInt(t.nodes)} / {fmtInt(t.edges)}</td></tr>
            <tr><td className="dim">模块数</td><td className="mono">{d.modules.length}</td></tr>
          </tbody>
        </table>
        {d.summary && (
          <div style={{ marginTop: 12, padding: 11, background: 'var(--bg-soft)', border: '1px solid var(--line-soft)', borderRadius: 8, fontSize: 12, color: 'var(--fg-mid)' }}>
            {d.summary}
          </div>
        )}
      </Card>
    </>
  );
}
