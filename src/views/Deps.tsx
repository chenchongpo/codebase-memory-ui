import { useMemo, useState } from 'react';
import { useApi, fmtInt } from '../api';
import type { Architecture as ArchData, Layers as LayersData, TreeNode } from '../types';
import { Badge, Card, Empty, ErrorBox, HBars, HelpLink, Kpi, Loading } from '../components/ui';
import { ForceGraph, LayerFlow } from '../components/graphs';
import type { ViewProps } from '../lib/nav';

/**
 * 依赖与分层。
 *
 * 原来的「架构图」与「分层图」讲的是同一件事——谁依赖谁、调用怎么流动——只是切法不同：
 *   · 模块 / 包视角：编译期 IMPORTS 聚合，回答「哪些模块耦在一起」；
 *   · 分层视角：按职责归层后看 CALLS 的跨层流向，回答「分层有没有被击穿」。
 * 合成一个视图后用顶部三档切换，避免在两个页面之间来回跳。
 */

const MOD_COLORS = ['#7aa2ff', '#38d9c4', '#ffc857', '#ff8a5c', '#d16bff', '#56b6ff', '#3ddc97', '#ff6b81', '#a78bfa', '#f0b429'];

const LAYER_COLOR: Record<string, string> = {
  L0: '#7aa2ff',
  L1: '#38d9c4',
  L2: '#ffc857',
  L3: '#ff8a5c',
  L4: '#d16bff',
  L5: '#56b6ff',
  LX: '#6b6b80',
};

type Tab = 'module' | 'package' | 'layer';

const TABS: { id: Tab; label: string }[] = [
  { id: 'module', label: '模块' },
  { id: 'package', label: '包' },
  { id: 'layer', label: '分层' },
];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

export default function Deps({ project, nav }: ViewProps) {
  const arch = useApi<ArchData>('/architecture', { project });
  const layers = useApi<LayersData>('/layers', { project });
  const [tab, setTab] = useState<Tab>('module');

  const modColor = (name: string) => MOD_COLORS[Math.abs(hash(name)) % MOD_COLORS.length];

  const graphNodes = useMemo(() => {
    if (!arch.data) return [];
    return tab === 'package'
      ? arch.data.packageNodes.map((n) => ({ id: n.id, label: n.label, sub: n.module, size: n.files, color: modColor(n.module) }))
      : arch.data.modules.map((m) => ({ id: m.name, label: m.name, sub: `${m.files} 文件`, size: m.loc, color: modColor(m.name) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arch.data, tab]);

  const needArch = tab === 'module' || tab === 'package';
  if (needArch ? arch.loading : layers.loading) return <Loading text="正在聚合依赖关系…" />;
  if (needArch ? arch.error : layers.error) return <ErrorBox msg={needArch ? arch.error! : layers.error!} />;
  if (!arch.data || !layers.data) return <Empty text="暂无数据" />;

  const a = arch.data;
  const l = layers.data;
  const bands = l.nodes.filter((n) => n.files > 0 || n.methods > 0);
  const maxFlow = Math.max(1, ...l.flows.map((f) => f.w));
  const layerIds = bands.map((b) => b.id);
  const matrix = new Map(l.flows.map((f) => [`${f.s}>${f.t}`, f.w]));

  return (
    <>
      <div className="kpis">
        <Kpi k="顶层模块" v={fmtInt(a.modules.length)} color="var(--accent)" />
        <Kpi k="已索引文件" v={fmtInt(a.fileCount)} color="var(--accent-3)" d={`${fmtInt(a.totalLoc)} 行代码`} />
        <Kpi k="包节点" v={fmtInt(a.packageNodes.length)} color="var(--accent-2)" d={`${fmtInt(a.packageEdges.length)} 条包级依赖`} />
        <Kpi k="模块依赖边" v={fmtInt(a.moduleEdges.length)} color="var(--warn)" d="来自 IMPORTS 边聚合" />
        <Kpi k="分层数" v={bands.length} color="var(--cx4)" d="按路径语义自动归层" />
        <Kpi k="跨层调用" v={fmtInt(l.flows.length)} color="var(--cx5)" d="来自 CALLS 边" />
        <Kpi k="对外接口" v={fmtInt(l.externalEntries)} color="var(--cx1)" d="HANDLES 边数量" />
      </div>

      <Card
        title={tab === 'layer' ? '分层架构图' : tab === 'module' ? '模块依赖图' : '包依赖图'}
        help={
          tab === 'layer' ? (
            <>
              每层一个横向条带（层内类聚合），右侧弧线 = 跨层调用，粗细与数值成正比。
              <HelpLink onClick={() => nav('metrics', { query: 'depend', token: Date.now() })}>归层规则</HelpLink>
            </>
          ) : (
            <>
              圆面积 = 代码行数 / 文件数，箭头 = 依赖方向，悬停高亮相邻节点，支持拖拽与缩放；权重来自 IMPORTS 边聚合，只看得到编译期依赖。
              <HelpLink onClick={() => nav('metrics', { query: 'depend', token: Date.now() })}>依赖口径</HelpLink>
            </>
          )
        }
        right={
          <div className="seg">
            {TABS.map((t) => (
              <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
                {t.label}
              </button>
            ))}
          </div>
        }
      >
        {tab === 'layer' ? (
          <>
            <LayerFlow layers={l.nodes} flows={l.flows} />
            <div className="tiny dim" style={{ marginTop: 8 }}>
              理想情况下箭头自上而下单向流动；出现大量回指（低层调高层）通常是分层被击穿的信号。
            </div>
          </>
        ) : (
          <ForceGraph
            nodes={graphNodes}
            edges={tab === 'module' ? a.moduleEdges : a.packageEdges}
            height={tab === 'module' ? 440 : 560}
            minR={tab === 'module' ? 16 : 7}
            maxR={tab === 'module' ? 46 : 22}
            onPick={(id) => (tab === 'module' ? nav('complexity', { module: id }) : nav('search', { query: id }))}
            edgeLabel={(w) => `${w} 次 import`}
          />
        )}
      </Card>

      {tab === 'module' && (
        <div className="grid c2">
          <Card title="模块明细" help="点行可跳到该模块的复杂度视图。" bodyClass="tight">
            <table className="tbl">
              <thead>
                <tr>
                  <th>模块</th>
                  <th className="num">文件</th>
                  <th className="num">包</th>
                  <th className="num">行数</th>
                  <th className="num">函数</th>
                  <th className="num">平均复杂度</th>
                  <th className="num">被改次数</th>
                </tr>
              </thead>
              <tbody>
                {a.modules.map((m) => (
                  <tr key={m.name} style={{ cursor: 'pointer' }} onClick={() => nav('complexity', { module: m.name })}>
                    <td className="mono">
                      <i style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: modColor(m.name), marginRight: 7 }} />
                      {m.name}
                    </td>
                    <td className="num dim">{m.files}</td>
                    <td className="num dim">{m.pkgs}</td>
                    <td className="num">{fmtInt(m.loc)}</td>
                    <td className="num dim">{m.methods}</td>
                    <td className="num dim">{m.avgCx}</td>
                    <td className="num dim">{m.changes || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <Card title="模块间依赖权重">
            <HBars
              rows={a.moduleEdges.slice(0, 14).map((e) => ({
                key: `${e.s}->${e.t}`,
                label: `${e.s} → ${e.t}`,
                value: e.w,
                color: modColor(e.s),
              }))}
              unit=" 次"
            />
            <div className="tiny dim" style={{ marginTop: 10 }}>
              反向箭头（B → A）若同时存在，说明两个模块互相依赖，是拆分时的首要障碍。
            </div>
          </Card>
        </div>
      )}

      {tab === 'package' && (
        <div className="grid c2">
          <Card title="目录构成">
            <DirTree nodes={a.tree} />
          </Card>
          <Card title="文件类型分布" hint={`共 ${fmtInt(a.fileCount)} 个已索引文件`}>
            <HBars rows={a.extStats.slice(0, 14).map((e) => ({ key: e.ext, label: e.ext, value: e.n, color: 'var(--accent-3)' }))} unit=" 个" />
          </Card>
        </div>
      )}

      {tab === 'layer' && (
        <>
          <div className="grid c2">
            <Card title="各层规模" help="点行可跳到该层的复杂度视图。" bodyClass="tight">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>层</th>
                    <th className="num">文件</th>
                    <th className="num">函数</th>
                    <th className="num">行数</th>
                    <th className="num">平均复杂度</th>
                    <th className="num">最高</th>
                    <th className="num">超 10 的函数</th>
                  </tr>
                </thead>
                <tbody>
                  {bands.map((b) => (
                    <tr key={b.id} style={{ cursor: 'pointer' }} onClick={() => nav('complexity')}>
                      <td className="mono">
                        <i style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: LAYER_COLOR[b.id], marginRight: 7 }} />
                        {b.label}
                      </td>
                      <td className="num dim">{b.files}</td>
                      <td className="num">{b.methods}</td>
                      <td className="num dim">{fmtInt(b.loc)}</td>
                      <td className="num dim">{b.avgCx}</td>
                      <td className="num">
                        <Badge tone={b.maxCx > 20 ? 'danger' : b.maxCx > 10 ? 'warn' : 'ok'}>{b.maxCx}</Badge>
                      </td>
                      <td className="num dim">{b.hotCx}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ padding: '10px 14px' }} className="tiny dim">
                {l.nodes.find((n) => n.id === 'LX')?.files ? (
                  <>有 {l.nodes.find((n) => n.id === 'LX')?.files ?? 0} 个文件未被任何规则命中，落在「其他」层，建议补充归层规则或检查目录命名。</>
                ) : (
                  <>全部文件都已命中归层规则，未出现未归类文件。</>
                )}
              </div>
            </Card>

            <Card title="跨层调用 TOP">
              <HBars
                rows={l.flows.slice(0, 16).map((f) => ({
                  key: `${f.s}->${f.t}`,
                  label: `${f.s} → ${f.t}`,
                  value: f.w,
                  color: LAYER_COLOR[f.s] ?? 'var(--accent)',
                }))}
                unit=" 次"
              />
            </Card>
          </div>

          <Card title="跨层调用矩阵" help="行 = 调用方所在层，列 = 被调方所在层；颜色越深调用越密集。" bodyClass="tight">
            <div style={{ overflowX: 'auto', padding: 14 }}>
              <table className="tbl" style={{ minWidth: 520 }}>
                <thead>
                  <tr>
                    <th>↓ 调用方 \ 被调方 →</th>
                    {layerIds.map((id) => (
                      <th key={id} className="num" style={{ color: LAYER_COLOR[id] }}>
                        {id}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {layerIds.map((s) => (
                    <tr key={s}>
                      <td className="mono" style={{ color: LAYER_COLOR[s] }}>
                        {s}
                      </td>
                      {layerIds.map((t) => {
                        const v = s === t ? null : matrix.get(`${s}>${t}`) ?? 0;
                        const intensity = v ? Math.min(0.85, 0.12 + (v / maxFlow) * 0.75) : 0;
                        const back = layerIds.indexOf(t) < layerIds.indexOf(s);
                        return (
                          <td
                            key={t}
                            className="num"
                            style={{
                              background: v ? `rgba(${back ? '255,107,129' : '122,162,255'},${intensity})` : s === t ? 'var(--panel-3)' : 'transparent',
                            }}
                          >
                            {s === t ? <span className="dim">—</span> : v || <span className="dim">0</span>}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="tiny dim" style={{ marginTop: 10 }}>
                蓝色 = 正常的自上而下调用；<span style={{ color: 'var(--danger)' }}>红色</span> = 反向回指（低层调高层），是最值得复核的架构味道。
              </div>
            </div>
          </Card>
        </>
      )}
    </>
  );
}

/** 目录树（按行数占比出横条） */
function DirTree({ nodes, depth = 0 }: { nodes: TreeNode[]; depth?: number }) {
  const [open, setOpen] = useState<Record<string, boolean>>(() => Object.fromEntries(nodes.slice(0, 6).map((n) => [n.path, true])));
  const max = Math.max(1, ...nodes.map((n) => n.loc));
  const toggle = (p: string) => setOpen((o) => ({ ...o, [p]: !o[p] }));

  return (
    <div>
      {nodes.map((n) => {
        const isOpen = open[n.path] ?? depth < 1;
        const hasKids = n.children.length > 0;
        return (
          <div key={n.path}>
            <div
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', paddingLeft: depth * 14, cursor: hasKids ? 'pointer' : 'default' }}
              onClick={() => hasKids && toggle(n.path)}
            >
              <span style={{ width: 12, color: 'var(--fg-faint)', fontFamily: 'var(--mono)', fontSize: 10 }}>{hasKids ? (isOpen ? '▾' : '▸') : '·'}</span>
              <span className="mono" style={{ fontSize: 11.5, color: hasKids ? 'var(--fg)' : 'var(--fg-mid)' }}>
                {n.name}
              </span>
              <div style={{ flex: 1, height: 5, background: 'var(--panel-3)', borderRadius: 3, overflow: 'hidden', maxWidth: 190 }}>
                <div style={{ width: `${(n.loc / max) * 100}%`, height: '100%', background: 'var(--accent)', opacity: 0.6 }} />
              </div>
              <span className="mono tiny dim" style={{ flex: 'none', minWidth: 68, textAlign: 'right' }}>
                {n.loc ? `${n.loc.toLocaleString()} 行` : ''}
              </span>
            </div>
            {hasKids && isOpen && <DirTree nodes={n.children} depth={depth + 1} />}
          </div>
        );
      })}
    </div>
  );
}
