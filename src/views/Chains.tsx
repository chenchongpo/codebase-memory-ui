import { useEffect, useMemo, useState } from 'react';
import { useApi, fmtInt } from '../api';
import type { BrowseData, BrowseRow, CallChains, CallChain } from '../types';
import { Badge, Card, Empty, ErrorBox, HelpLink, Kpi, Loading } from '../components/ui';
import { CallTree, SequenceCanvas, sequenceCanvasSize, treeSize } from '../components/chains';
import { Pager } from '../components/Pager';
import {
  buildCallTree,
  buildSequenceCanvas,
  CANVAS_CSV_HEAD,
  canvasCsvRows,
  CHAIN_CSV_HEAD,
  chainCsvRows,
  TREE_CSV_HEAD,
  treeCsvRows,
  viaHint,
} from '../lib/chains';
import { csvName, downloadCsv } from '../lib/csv';
import type { ViewProps } from '../lib/nav';

const MODE_LABEL: Record<CallChains['mode'], string> = {
  class: '类',
  package: '包',
  method: '方法',
  name: '名称模糊',
  picked: '选中节点',
  none: '未命中',
};

const DEPTHS = [1, 2, 3, 4, 5, 6, 8, 10];
const CHAIN_PAGE = 20;

type Picked = { id: number; name: string; cls: string; file: string; line: number };

/** 面包屑的一节：模块 → 子包 → 类（方法层只用来列方法，不再往下） */
type Crumb = {
  level: 'module' | 'package' | 'method';
  module: string;
  pkg: string;
  classId: number;
  label: string;
};

const ROOT: Crumb = { level: 'module', module: '', pkg: '', classId: 0, label: '全部模块' };

const LEVEL_TAG: Record<BrowseRow['level'], string> = {
  module: '模块',
  package: '包',
  class: '类',
  method: '方法',
};

export default function Chains({ project, payload, nav, openSource }: ViewProps) {
  /* ---------------- 起点选择：模块 → 包 → 类 → 方法 逐层下钻 ---------------- */
  const [trail, setTrail] = useState<Crumb[]>([ROOT]);
  const here = trail[trail.length - 1];
  const [kw, setKw] = useState('');
  const [pickPage, setPickPage] = useState(1);
  const browse = useApi<BrowseData>('/browse', {
    project,
    level: here.level,
    module: here.module,
    pkg: here.pkg,
    classId: here.classId || undefined,
    q: kw,
    page: pickPage,
    pageSize: 40,
  });

  /* ---------------- 链路查询状态 ---------------- */
  const prefill = payload?.query ?? '';
  const [q, setQ] = useState(prefill);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [dir, setDir] = useState<'up' | 'down'>('up');
  const [depth, setDepth] = useState(4);
  const [chainPage, setChainPage] = useState(1);
  /** 正向时序图当前画第几条链路（反向树图不看这个） */
  const [chainSel, setChainSel] = useState(0);
  const [zoomOpen, setZoomOpen] = useState(false);
  const [zoom, setZoom] = useState(1);

  const active = !!(picked || q.trim().length >= 2);
  const data = useApi<CallChains>(
    active ? '/chains' : null,
    active ? { project, q: picked ? '' : q, id: picked?.id, dir, depth, limit: 300 } : null
  );

  /* 从别处带 ?query 跳转过来时预填 */
  useEffect(() => {
    if (payload?.query && payload.query !== q) {
      setQ(payload.query);
      setPicked(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload?.query]);

  /* 换方向 / 深度 / 目标都回到第一页，并重选链路 */
  useEffect(() => {
    setChainPage(1);
    setChainSel(0);
  }, [dir, depth, q, picked?.id]);

  /* 放大窗口：ESC 关闭 + 锁滚动 */
  useEffect(() => {
    if (!zoomOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setZoomOpen(false);
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [zoomOpen]);

  const cur = data.data;
  const chains: CallChain[] = cur?.chains ?? [];
  const chainPages = Math.max(1, Math.ceil(chains.length / CHAIN_PAGE));
  const pageNo = Math.min(chainPage, chainPages);
  const pageChains = chains.slice((pageNo - 1) * CHAIN_PAGE, pageNo * CHAIN_PAGE);

  /* 反向：折成以被调用节点为根的树；正向：全部链路合成一张画布 */
  const tree = useMemo(() => buildCallTree(chains), [chains]);
  const canvas = useMemo(() => buildSequenceCanvas(chains), [chains]);
  /** 明细表点中的链路序号：不切换画布内容，只让画布滚到并高亮那一条 */
  const selNo = Math.min(chainSel, Math.max(0, chains.length - 1));
  const targetIds = (cur?.matched ?? []).map((m) => m.id);

  const run = (text?: string) => {
    setQ((text ?? '').trim());
    setPicked(null);
    setChainPage(1);
    setChainSel(0);
  };

  const clearQuery = () => {
    setQ('');
    setPicked(null);
    setChainPage(1);
    setChainSel(0);
  };

  const pick = (t: Picked) => {
    setPicked({ id: t.id, name: t.name, cls: t.cls, file: t.file, line: t.line });
    setQ(t.name);
    setChainPage(1);
    setChainSel(0);
  };

  /* ---------------- 逐层下钻 ---------------- */
  const gotoCrumb = (i: number) => {
    setTrail((t) => t.slice(0, i + 1));
    setKw('');
    setPickPage(1);
  };

  const pickClass = (r: BrowseRow) => {
    if (!r.id) return;
    pick({ id: r.id, name: r.name, cls: '', file: r.file ?? '', line: r.line ?? 0 });
  };

  const onRow = (r: BrowseRow) => {
    if (r.level === 'method') {
      if (r.id) pick({ id: r.id, name: r.name, cls: r.cls || here.label, file: r.file ?? '', line: r.line ?? 0 });
      return;
    }
    if (r.level === 'class' && !r.hasChildren) {
      pickClass(r);
      return;
    }
    setKw('');
    setPickPage(1);
    if (r.level === 'module') {
      setTrail([ROOT, { level: 'package', module: r.name, pkg: '', classId: 0, label: r.name }]);
    } else if (r.level === 'package') {
      setTrail((t) => [...t, { level: 'package', module: here.module, pkg: r.key, classId: 0, label: r.name }]);
    } else if (r.level === 'class' && r.id) {
      const id = r.id;
      setTrail((t) => [...t, { level: 'method', module: here.module, pkg: here.pkg, classId: id, label: r.name }]);
    }
  };

  const fitToWindow = () => {
    const naturalW = dir === 'up' ? treeSize(tree).width : sequenceCanvasSize(canvas).width;
    const avail = Math.min(1520, window.innerWidth * 0.96) - 40;
    const next = Math.min(1, Math.max(0.4, Math.round((avail / naturalW) * 20) / 20));
    setZoom(next);
    return next;
  };

  /* ---------------- 导出（表单 = 带表头的 CSV，Excel 直接可读） ---------------- */
  const exportDiagram = () => {
    if (!cur) return;
    const tag = `${dir === 'up' ? '反向调用树' : '正向时序图'}_${picked?.name || cur.query}`;
    if (dir === 'up') {
      if (!tree.rows.length) return;
      downloadCsv(csvName(tag, project), TREE_CSV_HEAD, treeCsvRows(tree));
    } else {
      if (!canvas.bands.length) return;
      downloadCsv(csvName(tag, project), CANVAS_CSV_HEAD, canvasCsvRows(canvas));
    }
  };

  const exportChains = () => {
    if (!chains.length) return;
    downloadCsv(csvName(`调用链路明细_${picked?.name || cur?.query || ''}`, project), CHAIN_CSV_HEAD, chainCsvRows(chains));
  };

  const neighbors = dir === 'up' ? cur?.directCallers ?? [] : cur?.directCallees ?? [];

  return (
    <>
      <div className="kpis">
        <Kpi k="命中目标" v={fmtInt(cur?.stats.matched ?? 0)} color="var(--accent)" d={cur ? `按${MODE_LABEL[cur.mode]}命中` : '先选一个类或方法'} />
        <Kpi k="目标节点" v={fmtInt(cur?.stats.targets ?? 0)} color="var(--accent-2)" d="类会展开为其成员方法" />
        <Kpi k="链路" v={fmtInt(cur?.stats.chains ?? 0)} color="var(--warn)" d={cur?.stats.truncated ? '已达条数上限，已截断' : `最深 ${cur?.stats.maxHops ?? 0} 层`} />
        <Kpi k={dir === 'up' ? '直接调用方' : '直接被调'} v={fmtInt(dir === 'up' ? cur?.stats.directCallers ?? 0 : cur?.stats.directCallees ?? 0)} color="var(--accent-3)" />
        <Kpi k="接口派发链路" v={fmtInt(cur?.stats.indirectChains ?? 0)} color="var(--cx4)" d="经 OVERRIDE 跨接口" />
        <Kpi
          k="不可靠跳"
          v={fmtInt(cur?.stats.suspectHops ?? 0)}
          color="var(--danger)"
          d={cur ? `分布在 ${fmtInt(cur.stats.suspectChains)} 条链上 · 已标红待核对` : '解析溯源为「推断不可靠」的跳数'}
        />
      </div>

      <div className="split">
        <Card
          title="选择起点"
          help={
            <>
              模块 → 包 → 类 → 方法逐层下钻；点类右侧「查」可跳过方法直接查整个类。
              <HelpLink onClick={() => nav('metrics', { query: 'chain', token: Date.now() })}>调用链与解析溯源口径</HelpLink>
            </>
          }
          right={
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <div className="seg">
                <button className={dir === 'up' ? 'on' : ''} onClick={() => setDir('up')} title="沿 CALLS 边反向：谁调用了它（画成调用树，根 = 被调用节点）">
                  ↑ 反向调用树
                </button>
                <button className={dir === 'down' ? 'on' : ''} onClick={() => setDir('down')} title="沿 CALLS 边正向：它调用了谁（画成时序图）">
                  ↓ 正向时序
                </button>
              </div>
              <select value={depth} onChange={(e) => setDepth(Number(e.target.value))} title="展开层数">
                {DEPTHS.map((n) => (
                  <option key={n} value={n}>{n} 层</option>
                ))}
              </select>
              <button className="btn sm" disabled={trail.length <= 1} onClick={() => gotoCrumb(trail.length - 2)} title="回到上一层目录">
                ↑ 上一级
              </button>
              {active && <button className="btn sm" onClick={clearQuery}>清空</button>}
            </div>
          }
          bodyClass="tight"
        >
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 4,
              alignItems: 'center',
              padding: '8px 10px',
              borderBottom: '1px solid var(--line-soft)',
            }}
          >
            {trail.map((c, i) => {
              const last = i === trail.length - 1;
              return (
                <span key={`${c.level}-${c.label}-${i}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  {i > 0 && <span className="dim" style={{ fontSize: 10 }}>›</span>}
                  <button
                    className="chip mono crumb"
                    style={{
                      cursor: last ? 'default' : 'pointer',
                      background: last ? 'var(--panel-3)' : 'transparent',
                      borderColor: last ? 'var(--accent)' : undefined,
                    }}
                    onClick={() => !last && gotoCrumb(i)}
                    title={c.level === 'module' ? '回到模块列表' : c.label}
                  >
                    {c.label}
                  </button>
                </span>
              );
            })}
            <span className="grow" />
            <span className="tiny dim">{browse.data ? `${fmtInt(browse.data.filtered)} 项` : ''}</span>
          </div>

          <div style={{ padding: 10, borderBottom: '1px solid var(--line-soft)' }}>
            <input
              type="search"
              placeholder={here.level === 'method' ? '在本类方法里过滤…' : '在本层过滤名称…'}
              value={kw}
              onChange={(e) => {
                setKw(e.target.value);
                setPickPage(1);
              }}
            />
          </div>

          {browse.loading && !browse.data ? (
            <Loading text="正在列出可选项…" />
          ) : browse.error ? (
            <ErrorBox msg={browse.error} />
          ) : (
            <>
              <div className="list" style={{ maxHeight: 470 }}>
                {(browse.data?.rows ?? []).map((r) => {
                  const on = !!picked && r.id === picked.id;
                  return (
                    <div
                      key={`${r.level}-${r.key}`}
                      className={`list-item ${on ? 'on' : ''}`}
                      onClick={() => onRow(r)}
                      title={r.file ? `${r.file}${r.line ? `:${r.line}` : ''}` : r.key}
                    >
                      <div className="li-main" style={{ minWidth: 0 }}>
                        <div className="li-t mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {r.level === 'method' && r.cls ? `${r.cls}.` : ''}
                          {r.name}
                        </div>
                        <div className="li-s" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.sub}</div>
                      </div>
                      <span className="tiny dim" style={{ flex: 'none' }}>{LEVEL_TAG[r.level]}</span>
                      {r.level === 'class' && r.id ? (
                        <button
                          className="btn sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            pickClass(r);
                          }}
                          title="不看方法，直接查这个类的链路"
                        >
                          查
                        </button>
                      ) : r.hasChildren ? (
                        <span className="dim" style={{ fontFamily: 'var(--mono)' }}>›</span>
                      ) : null}
                    </div>
                  );
                })}
                {browse.data && !browse.data.rows.length && (
                  <Empty
                    text={
                      here.level === 'method'
                        ? '这个类下没有方法节点'
                        : kw
                          ? '本层没有匹配项，换个关键词或往上退一层'
                          : '这一层是空的'
                    }
                  />
                )}
              </div>
              {browse.data && <Pager meta={browse.data} loading={browse.loading} onPage={setPickPage} unit="项" />}
            </>
          )}
        </Card>

        <div>
          <Card
            title={dir === 'up' ? '反向调用树：谁调用了它（根 = 被调用节点）' : '正向时序图：它调用了谁'}
            help={
              <>
                反向 = 改这个方法会影响哪些入口；正向 = 一次请求最终落到哪里。黄色虚线 = 接口 → 实现派发。
                <HelpLink onClick={() => nav('metrics', { query: 'chain', token: Date.now() })}>调用链口径</HelpLink>
              </>
            }
            hint={
              !cur
                ? undefined
                : dir === 'up'
                  ? `${fmtInt(tree.rows.length)} 个节点 · 最深 ${tree.maxDepth} 层`
                  : canvas.bands.length
                    ? `${fmtInt(canvas.bands.length)} 条链路 · ${fmtInt(canvas.totalRows)} 次调用 · 同一画布`
                    : undefined
            }
            right={
              cur && chains.length > 0 ? (
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <button className="btn sm" onClick={exportDiagram} title={dir === 'up' ? '导出调用树表（CSV）' : '导出时序消息表（CSV）'}>
                    {dir === 'up' ? '导出树表' : '导出时序表'}
                  </button>
                  <button className="btn sm" onClick={() => { fitToWindow(); setZoomOpen(true); }}>放大</button>
                </div>
              ) : null
            }
          >
            {!active ? (
              <Empty text="左侧从模块开始一层层点，选一个类或方法" />
            ) : data.loading && !cur ? (
              <Loading text="正在生成链路…" />
            ) : data.error ? (
              <ErrorBox msg={data.error} />
            ) : cur && cur.mode === 'none' ? (
              <div style={{ padding: '6px 2px' }}>
                <div className="tiny" style={{ color: 'var(--warn)', marginBottom: 8 }}>
                  没有找到「{cur.query}」对应的类、包或方法。{cur.suggest.length ? '是不是想查：' : ''}
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {cur.suggest.map((name) => (
                    <button key={name} className="chip mono" style={{ cursor: 'pointer', background: 'transparent' }} onClick={() => run(name)}>
                      {name}
                    </button>
                  ))}
                </div>
              </div>
            ) : chains.length === 0 ? (
              <Empty text={dir === 'up' ? '没有任何节点调用它（可能只被框架反射调用）' : '它没有再调用包内其它方法'} />
            ) : dir === 'up' ? (
              <>
                <CallTree model={tree} onOpen={openSource} />
                {tree.truncated && (
                  <div className="tiny dim" style={{ marginTop: 6 }}>
                    节点数已达绘图上限，树只画了前 {fmtInt(tree.rows.length)} 个节点；完整数据请点右上「导出树表」。
                  </div>
                )}
              </>
            ) : (
              <>
                <SequenceCanvas model={canvas} onOpen={openSource} focusIndex={selNo} />
                {canvas.droppedChains > 0 && (
                  <div className="tiny" style={{ marginTop: 6, color: 'var(--warn)' }}>
                    链路过多，画布只画了前 {fmtInt(canvas.bands.length)} 条（{fmtInt(canvas.totalRows)} 次调用），
                    还有 {fmtInt(canvas.droppedChains)} 条未画。全部数据请点「导出时序表」。
                  </div>
                )}
                <div className="tiny dim" style={{ marginTop: 6 }}>
                  全部链路画在同一张画布里竖着堆叠，同一个类固定在同一列，纵向扫一列即可比较各条链路；
                  点下方明细表任一行会滚到并高亮该链路。
                </div>
              </>
            )}
          </Card>
        </div>
      </div>

      <Card
        title="链路明细"
        help={
          <>
            <b style={{ color: 'var(--danger)' }}>⚠ 标红 = 这一跳是索引器推断的、不可靠</b>
            （多为 JDK / 三方库调用被错接到项目内同名方法），悬停可看解析来源与候选数，<b>请对照源码核对</b>。
            <HelpLink onClick={() => nav('metrics', { query: 'chain', token: Date.now() })}>溯源三档口径</HelpLink>
          </>
        }
        right={
          chains.length > 0 ? (
            <button className="btn sm" onClick={exportChains} title="导出全部链路（CSV）">
              导出明细
            </button>
          ) : null
        }
        bodyClass="tight"
      >
        {!active ? (
          <Empty text="暂无链路" />
        ) : chains.length === 0 ? (
          <Empty text="暂无链路" />
        ) : (
          <>
            <div style={{ maxHeight: 420, overflow: 'auto' }}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th style={{ width: 44 }}>#</th>
                    <th>链路（{dir === 'up' ? '最外层调用方 → 目标' : '起点 → 叶子'}）</th>
                    <th className="num" style={{ width: 64 }} title="该链中解析不可靠的跳数">⚠</th>
                    <th className="num" style={{ width: 52 }}>层数</th>
                  </tr>
                </thead>
                <tbody>
                  {pageChains.map((c, i) => {
                    const idx = (pageNo - 1) * CHAIN_PAGE + i;
                    const on = dir === 'down' && idx === selNo;
                    return (
                      <tr
                        key={`${idx}`}
                        onClick={() => dir === 'down' && setChainSel(idx)}
                        style={on ? { background: 'var(--panel-3)', cursor: 'pointer' } : { cursor: dir === 'down' ? 'pointer' : 'default' }}
                        title={dir === 'down' ? '点这一行在上方时序图里展开' : undefined}
                      >
                        <td className="num dim">{idx + 1}</td>
                        <td>
                          <div className="chain">
                            {c.steps.map((s, k) => (
                              <span key={`${s.id}-${k}`} className="chain-seg">
                                {k > 0 && <span className="chain-arrow">›</span>}
                                <span
                                  className={`chain-node ${s.isEntry ? 'entry' : ''} ${s.virtual ? 'indirect' : ''} ${
                                    s.via?.kind === 'suspect' ? 'suspect' : s.via?.kind === 'inferred' ? 'inferred' : ''
                                  }`}
                                  onClick={() => openSource(s.file, s.callLine || s.line)}
                                  title={`${s.file}:${s.callLine || s.line}${
                                    s.virtual ? '（接口/实现派发）' : ''
                                  }${viaHint(s.via) ? `\n${viaHint(s.via)}` : ''}`}
                                >
                                  {s.cls ? `${s.cls}.` : ''}
                                  {s.name}
                                  {k < c.steps.length - 1 && s.callLine ? <i className="chain-line">:{s.callLine}</i> : null}
                                  {s.via?.kind === 'suspect' ? <i className="chain-suspect" aria-label="该跳解析不可靠">⚠</i> : null}
                                </span>
                              </span>
                            ))}
                            {c.cut && <span className="chain-cut" title="已达深度上限，还能继续展开">…</span>}
                          </div>
                        </td>
                        <td className="num">
                          {c.suspect > 0 ? (
                            <Badge tone="danger" >{c.suspect}</Badge>
                          ) : c.inferred > 0 ? (
                            <Badge tone="warn">{c.inferred}</Badge>
                          ) : (
                            <span className="dim">—</span>
                          )}
                        </td>
                        <td className="num">
                          <Badge tone={c.entry ? 'ok' : c.cut ? 'warn' : 'mute'}>{c.hops}</Badge>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pager
              meta={{
                page: pageNo,
                pageSize: CHAIN_PAGE,
                totalPages: chainPages,
                filtered: chains.length,
                from: (pageNo - 1) * CHAIN_PAGE + 1,
                to: Math.min(chains.length, pageNo * CHAIN_PAGE),
              }}
              onPage={setChainPage}
              unit="条"
            />
          </>
        )}
      </Card>

      <Card
        title={dir === 'up' ? '直接调用方' : '直接被调'}
        help={<>按调用点数量排序；「派发」徽章 = 该调用经接口/父类方法派发而来，不是直接落在实现上。</>}
        bodyClass="tight"
      >
        {neighbors.length === 0 ? (
          <Empty text={dir === 'up' ? '没有任何节点直接调用它' : '它没有再调用其它方法'} />
        ) : (
          <div style={{ maxHeight: 320, overflow: 'auto' }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>{dir === 'up' ? '调用方' : '被调方法'}</th>
                  <th>所属类</th>
                  <th className="num">调用点</th>
                  <th>位置</th>
                </tr>
              </thead>
              <tbody>
                {neighbors.map((c) => (
                  <tr key={c.id}>
                    <td className="mono">
                      {c.name}
                      {c.isEntry && <Badge tone="info">入口</Badge>}
                      {c.viaDispatch && <Badge tone="warn">派发</Badge>}
                    </td>
                    <td className="mono dim">{c.cls || '—'}</td>
                    <td className="num"><Badge tone="warn">{c.calls}</Badge></td>
                    <td>
                      <span className="mono tiny" style={{ color: 'var(--accent)', cursor: 'pointer' }} onClick={() => openSource(c.file, c.line)} title={c.file}>
                        {c.file.split('/').slice(-2).join('/')}:{c.line}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {zoomOpen && cur && (
        <div
          className="zoom-overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setZoomOpen(false);
          }}
        >
          <div className="zoom-panel" onMouseDown={(e) => e.stopPropagation()}>
            <div className="zoom-head">
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="mono" style={{ fontSize: 12, color: 'var(--fg)' }}>
                  {dir === 'up' ? '反向调用树：谁调用了' : '正向时序画布：全部链路'} {picked?.name || q}
                </div>
                <div className="tiny dim" style={{ marginTop: 2 }}>
                  {dir === 'up'
                    ? `${fmtInt(tree.rows.length)} 个节点 · 最深 ${tree.maxDepth} 层 · 放大窗口内可滚动查看`
                    : `${fmtInt(canvas.bands.length)} 条链路 · ${fmtInt(canvas.totalRows)} 次调用 · 画布 ${fmtInt(sequenceCanvasSize(canvas).width)}×${fmtInt(sequenceCanvasSize(canvas).height)} px`}
                </div>
              </div>
              <div className="zoom-tools">
                <button className="btn sm" title="缩小" onClick={() => setZoom((z) => Math.max(0.4, Math.round((z - 0.1) * 10) / 10))}>
                  −
                </button>
                <span className="mono tiny dim" style={{ width: 42, textAlign: 'center' }}>
                  {Math.round(zoom * 100)}%
                </span>
                <button className="btn sm" title="放大" onClick={() => setZoom((z) => Math.min(2.5, Math.round((z + 0.1) * 10) / 10))}>
                  +
                </button>
                <button className="btn sm" title="按窗口宽度适应" onClick={() => fitToWindow()}>适应</button>
                <button className="btn sm" onClick={() => setZoom(1)}>100%</button>
                <button className="btn sm" onClick={() => setZoomOpen(false)}>关闭</button>
              </div>
            </div>
            <div className="zoom-body">
              {dir === 'up' ? (
                <CallTree model={tree} onOpen={openSource} fit={false} zoom={zoom} />
              ) : (
                <SequenceCanvas model={canvas} onOpen={openSource} fit={false} zoom={zoom} focusIndex={selNo} />
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
