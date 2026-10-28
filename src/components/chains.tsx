import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { CallTreeModel, SeqCanvasModel, TreeRow } from '../lib/chains';
import { viaHint } from '../lib/chains';

const ARROW = 'cbc-arrow';

function Defs({ color = '#5a6a8a' }: { color?: string }) {
  return (
    <defs>
      <marker id={ARROW} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill={color} />
      </marker>
    </defs>
  );
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** 调用深度配色：L1 最浅（绿）→ 越深越紫，与复杂度分档色一致 */
const DEPTH_COLORS = ['#3ddc97', '#56b6ff', '#ffc857', '#ff8a5c', '#d16bff'];
const depthColor = (d: number) => DEPTH_COLORS[Math.min(Math.max(d - 1, 0), DEPTH_COLORS.length - 1)];

/* ======================================================== 合并时序画布（全部链路） */

const CV_PAD = 14;
const CV_GUTTER = 58;
const CV_COL = 156;
const CV_BOX_W = CV_COL - 20;
const CV_BOX_H = 30;
const CV_HEAD = 16;
const CV_ROW = 26;
const CV_BAND_GAP = 9;

interface CanvasLayout {
  width: number;
  height: number;
  /** 每个 band 的顶部 y（消息区从 top + CV_HEAD 开始） */
  tops: number[];
  headerH: number;
}

function layoutCanvas(model: SeqCanvasModel): CanvasLayout {
  const headerH = CV_BOX_H + 16;
  const tops: number[] = [];
  let y = CV_PAD + headerH;
  for (const b of model.bands) {
    tops.push(y);
    y += CV_HEAD + b.messages.length * CV_ROW + CV_BAND_GAP;
  }
  const cols = Math.max(1, model.participants.length);
  return {
    width: CV_PAD * 2 + CV_GUTTER + cols * CV_COL,
    height: y + CV_PAD,
    tops,
    headerH,
  };
}

/** 画布尺寸口径与组件一致，供放大窗口估算缩放比例 */
export function sequenceCanvasSize(model: SeqCanvasModel) {
  const { width, height } = layoutCanvas(model);
  return { width, height };
}

/**
 * 合并时序画布：**全部链路堆在一张画布里**，而不是一次只画一条再翻页。
 *
 * 两个组织原则：
 *   - 调用时序：参与者列按首次被调顺序排，入口类最左、越右越深；单条链从左到右就是调用顺序；
 *   - 调用深度：每条消息左侧标 L n（n = 第几层调用），配深浅色阶，扫一眼就能看出链路钻了多深。
 * 加上「同类同列」，纵向扫同一列还能看出这个类在各条链路里分别在第几层被调用。
 *
 * 规模靠三件事消化：① 每行 26px 的紧凑行高；② 行数上限（超出不画并提示，避免画卡）；
 * ③ 缩放：默认按容器宽度适应，可 10%–250% 调；点明细表某行会滚到并高亮对应链路带。
 */
export function SequenceCanvas({
  model,
  onOpen,
  fit = true,
  zoom = 1,
  focusIndex = null,
}: {
  model: SeqCanvasModel;
  onOpen?: (f: string, l?: number) => void;
  fit?: boolean;
  zoom?: number;
  /** 要高亮的链路序号（点明细表某行时传入） */
  focusIndex?: number | null;
}) {
  const lay = useMemo(() => layoutCanvas(model), [model]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<string | null>(null);

  const xOf = (c: number) => CV_PAD + CV_GUTTER + c * CV_COL + CV_COL / 2;

  /* 点明细表某行 → 滚到对应链路带（没有 scrollIntoView 的环境下退化为直接设 scrollTop） */
  useEffect(() => {
    if (focusIndex === null || focusIndex === undefined) return;
    const row = model.bands.findIndex((b) => b.index === focusIndex);
    if (row < 0) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = Math.max(0, lay.tops[row] - 24);
  }, [focusIndex, model, lay]);

  /*
   * 缩放下限：无脑「按容器宽度适应」在多列画布上会把 9.5px 的文字压到 1~2px，等于不可读。
   * 因此设可读性下限 35%：再宽就保留 35% 并允许横向滚动，宁可滚，也不给一张看不清的图。
   */
  const MIN_FIT = 0.35;
  const svgStyle: React.CSSProperties = fit
    ? { width: '100%', height: 'auto', minWidth: Math.round(lay.width * MIN_FIT), display: 'block' }
    : { width: lay.width * zoom, height: lay.height * zoom, minWidth: 0, display: 'block' };

  if (!model.bands.length) return null;

  return (
    <div className="chart-wrap">
      <div ref={scrollRef} style={{ overflowX: 'auto', overflowY: 'auto', maxHeight: fit ? 620 : undefined }}>
        <svg className="chart" viewBox={`0 0 ${lay.width} ${lay.height}`} preserveAspectRatio="xMidYMin meet" style={svgStyle}>
          <Defs />

          {/* 参与者表头：只画一次，靠列对齐在长画布里保持可比；列序 = 调用时序（左浅右深） */}
          {model.participants.map((p, c) => {
            const cx = xOf(c);
            return (
              <g key={`ph-${p.key}`}>
                <rect
                  x={cx - CV_BOX_W / 2}
                  y={CV_PAD}
                  width={CV_BOX_W}
                  height={CV_BOX_H}
                  rx={6}
                  fill="var(--panel-2)"
                  stroke="var(--line)"
                />
                <text x={cx} y={CV_PAD + 13} textAnchor="middle" style={{ fill: 'var(--fg-mid)', fontSize: 9.5, fontFamily: 'var(--mono)' }}>
                  {cut(p.name, 20)}
                </text>
                <text x={cx} y={CV_PAD + 25} textAnchor="middle" style={{ fill: 'var(--fg-faint)', fontSize: 8.5, fontFamily: 'var(--mono)' }}>
                  {`#${c + 1} · ×${p.freq}`}
                </text>
              </g>
            );
          })}

          {model.bands.map((b, row) => {
            const top = lay.tops[row];
            const bottom = top + CV_HEAD + b.messages.length * CV_ROW + (CV_BAND_GAP - 6);
            const focused = focusIndex === b.index;
            const used = new Set<number>();
            for (const m of b.messages) {
              used.add(m.from);
              used.add(m.to);
            }
            return (
              <g key={`b-${b.index}`}>
                {/* 带底色：隔行浅底 + 聚焦描边，便于在长画布里区分链路 */}
                <rect
                  x={CV_PAD}
                  y={top - 4}
                  width={lay.width - CV_PAD * 2}
                  height={bottom - top + 8}
                  rx={6}
                  fill={focused ? 'rgba(122,162,255,.10)' : row % 2 ? 'var(--panel-2)' : 'transparent'}
                  fillOpacity={focused ? 1 : 0.5}
                  stroke={focused ? 'rgba(122,162,255,.75)' : 'transparent'}
                  strokeWidth={focused ? 1.4 : 0}
                />
                {/* 左侧 gutter：链路序号 + 层数 + 可疑跳告警 */}
                <text
                  x={CV_PAD + 4}
                  y={top + 9}
                  style={{ fill: focused ? 'var(--accent)' : 'var(--fg-faint)', fontSize: 9, fontFamily: 'var(--mono)' }}
                >
                  #{b.index + 1}
                </text>
                <text x={CV_PAD + 4} y={top + 20} style={{ fill: 'var(--fg-faint)', fontSize: 8, fontFamily: 'var(--mono)' }}>
                  {b.hops}层
                </text>
                {b.suspect > 0 && (
                  <text x={CV_PAD + 30} y={top + 9} style={{ fill: 'var(--danger)', fontSize: 9, fontFamily: 'var(--mono)' }}>
                    ⚠{b.suspect}
                  </text>
                )}

                {/* 该带内每条参与者的生命线（只画本条链路用到的列） */}
                {[...used].map((c) => (
                  <line
                    key={`l-${b.index}-${c}`}
                    x1={xOf(c)}
                    x2={xOf(c)}
                    y1={top + CV_HEAD}
                    y2={bottom}
                    stroke="var(--line)"
                    strokeOpacity={0.5}
                    strokeDasharray="3 4"
                  />
                ))}

                {/* 消息 */}
                {b.messages.map((m) => {
                  const y = top + CV_HEAD + m.i * CV_ROW;
                  const self = m.from === m.to;
                  const x1 = xOf(m.from);
                  const x2 = xOf(m.to);
                  const key = `${b.index}-${m.i}`;
                  const active = hover === key;
                  const suspect = m.toStep.via?.kind === 'suspect';
                  const inferred = m.toStep.via?.kind === 'inferred';
                  const tone = suspect ? 'var(--danger)' : m.virtual ? 'var(--warn)' : active ? 'var(--accent)' : 'var(--fg-mid)';
                  const label = `${suspect ? '⚠ ' : ''}${m.toStep.name}`;
                  const labelFill = suspect ? 'var(--danger)' : inferred ? 'var(--warn)' : active ? 'var(--fg)' : 'var(--fg-mid)';
                  return (
                    <g
                      key={`m-${key}`}
                      onMouseEnter={() => setHover(key)}
                      onMouseLeave={() => setHover(null)}
                      style={{ cursor: onOpen ? 'pointer' : 'default' }}
                      onClick={() => onOpen && onOpen(m.fromStep.file, m.line || m.fromStep.line)}
                    >
                      <title>{`#${b.index + 1} 第 ${m.i} 层调用 · ${viaHint(m.toStep.via) || `${m.toStep.cls || ''}.${m.toStep.name}`}`}</title>
                      {/* 左侧深度标：L1 = 入口的直接调用，颜色随深度由浅变深 */}
                      <text
                        x={CV_PAD + 4}
                        y={y + 3.5}
                        style={{ fill: active ? 'var(--fg)' : depthColor(m.i), fontSize: 8, fontFamily: 'var(--mono)', opacity: active ? 1 : 0.9 }}
                      >
                        {`L${m.i}`}
                      </text>
                      {self ? (
                        <>
                          <path
                            d={`M${x1 + 5},${y - 7} h22 a6,6 0 1 1 0,14 h-22`}
                            fill="none"
                            stroke={tone}
                            strokeWidth={active ? 1.7 : 1.1}
                            strokeDasharray={m.virtual ? '4 3' : suspect ? '5 2' : undefined}
                            markerEnd={`url(#${ARROW})`}
                          />
                          <text x={x1 + 36} y={y - 2} style={{ fill: labelFill, fontSize: 9.5, fontFamily: 'var(--mono)' }}>
                            {cut(label, 16)}
                          </text>
                        </>
                      ) : (
                        <>
                          <line
                            x1={x1 + (x2 > x1 ? 6 : -6)}
                            y1={y}
                            x2={x2 + (x2 > x1 ? -8 : 8)}
                            y2={y}
                            stroke={tone}
                            strokeOpacity={active ? 1 : 0.85}
                            strokeWidth={active ? 1.8 : 1.2}
                            strokeDasharray={m.virtual ? '4 3' : suspect ? '5 2' : undefined}
                            markerEnd={`url(#${ARROW})`}
                          />
                          <text
                            x={(x1 + x2) / 2}
                            y={y - 4}
                            textAnchor="middle"
                            style={{ fill: labelFill, fontSize: 9.5, fontFamily: 'var(--mono)' }}
                          >
                            {cut(label, 20)}
                          </text>
                          {m.line > 0 && (
                            <text
                              x={(x1 + x2) / 2}
                              y={y + 10}
                              textAnchor="middle"
                              style={{ fill: 'var(--fg-faint)', fontSize: 8, fontFamily: 'var(--mono)' }}
                            >
                              :{m.line}
                            </text>
                          )}
                        </>
                      )}
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>
      </div>

      <div className="legend">
        <span className="legend-item">
          一次画出全部 {model.bands.length} 条链路，竖着堆叠、<b>同类同列</b>对齐；参与者<b>按调用时序排</b>（左 = 入口，越右被调得越晚），
          左侧 <code>#n</code> = 明细表行号，<code>L n</code> = 第 n 层调用（颜色由浅到深）
        </span>
        <span className="legend-item">
          <span style={{ borderBottom: '1px dashed var(--warn)', paddingBottom: 1 }}>黄色虚线</span> = 接口 → 实现派发（OVERRIDE）
        </span>
        <span className="legend-item" style={{ color: 'var(--danger)' }}>
          ⚠ 红色箭头 = 这一跳解析不可靠，请对照源码核对；<span style={{ color: 'var(--fg-faint)' }}>自环 = 同类内部调用</span>
        </span>
      </div>
    </div>
  );
}

/* ============================================================== 反向调用树 */

const CT_BOX_W = 178;
const CT_BOX_H = 36;
const CT_GAP_X = 44;
const CT_GAP_Y = 14;
const CT_PAD = 14;

/** 画布尺寸口径与组件一致，供放大窗口估算缩放比例 */
export function treeSize(model: CallTreeModel) {
  const rows = Math.max(1, model.rows.length);
  return {
    width: CT_PAD * 2 + (model.maxDepth + 1) * CT_BOX_W + model.maxDepth * CT_GAP_X,
    height: CT_PAD * 2 + rows * (CT_BOX_H + CT_GAP_Y),
  };
}

/**
 * 反向调用树：被调用节点当根，往右一层层是「谁调用了它」。
 *
 * 箭头由调用方指向被调方（即从右往左），因为业务语义上「它调用了上层」；
 * 同层同节点只画一次并标出经过的链路条数，避免同一段调用被画成几十条平行线。
 */
export function CallTree({
  model,
  onOpen,
  fit = true,
  zoom = 1,
}: {
  model: CallTreeModel;
  onOpen?: (f: string, l?: number) => void;
  fit?: boolean;
  zoom?: number;
}) {
  const [hover, setHover] = useState<string | null>(null);

  const layout = useMemo(() => {
    const yMap = new Map<string, number>();
    let slot = 0;
    const walk = (row: TreeRow, seen: Set<string>): number => {
      const got = yMap.get(row.key);
      if (got !== undefined) return got;
      seen.add(row.key);
      const kids = (model.children.get(row.key) ?? []).filter((k) => !seen.has(k.key));
      let y: number;
      if (kids.length === 0) {
        y = slot * (CT_BOX_H + CT_GAP_Y);
        slot += 1;
      } else {
        const ys = kids.map((k) => walk(k, seen));
        y = (ys[0] + ys[ys.length - 1]) / 2;
      }
      yMap.set(row.key, y);
      return y;
    };
    for (const r of model.roots) walk(r, new Set());
    for (const r of model.rows) if (!yMap.has(r.key)) walk(r, new Set());
    return { yMap, slots: Math.max(1, slot) };
  }, [model]);

  const xOf = (depth: number) => CT_PAD + depth * (CT_BOX_W + CT_GAP_X);
  const width = CT_PAD * 2 + (model.maxDepth + 1) * CT_BOX_W + model.maxDepth * CT_GAP_X;
  const height = CT_PAD * 2 + layout.slots * (CT_BOX_H + CT_GAP_Y);
  const yOf = (key: string) => CT_PAD + (layout.yMap.get(key) ?? 0);

  const svgStyle: React.CSSProperties = fit
    ? { width: '100%', height: 'auto', minWidth: 0, display: 'block' }
    : { width: width * zoom, height: height * zoom, minWidth: 0, display: 'block' };

  return (
    <div className="chart-wrap">
      <div style={{ overflowX: fit ? 'hidden' : 'auto', overflowY: 'auto', maxHeight: fit ? 620 : undefined }}>
        <svg className="chart" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMin meet" style={svgStyle}>
          <Defs />

          {/* 层标题 */}
          {Array.from({ length: model.maxDepth + 1 }, (_, d) => (
            <text
              key={`h-${d}`}
              x={xOf(d) + 2}
              y={11}
              style={{ fill: d === 0 ? 'var(--fg-mid)' : 'var(--fg-faint)', fontSize: 9, fontFamily: 'var(--mono)' }}
            >
              {d === 0 ? '被调用节点（根）' : `第 ${d} 层调用方`}
            </text>
          ))}

          {/* 边：调用方 → 被调方 */}
          {model.rows.map((r) => {
            if (!r.parentKey) return null;
            const p = model.byKey.get(r.parentKey);
            if (!p) return null;
            const x1 = xOf(r.depth);
            const y1 = yOf(r.key) + CT_BOX_H / 2;
            const x2 = xOf(p.depth) + CT_BOX_W;
            const y2 = yOf(p.key) + CT_BOX_H / 2;
            const mx = (x1 + x2) / 2;
            const active = hover === r.key || hover === r.parentKey;
            // 「谁调用了它」这条边就是 r.step.via 记录的那一跳：解析不可靠就整条边标红
            const suspect = r.step.via?.kind === 'suspect';
            const tone = suspect ? 'var(--danger)' : r.step.virtual ? 'var(--warn)' : active ? 'var(--accent)' : 'var(--fg-faint)';
            return (
              <g key={`e-${r.key}`}>
                <title>{viaHint(r.step.via)}</title>
                <path
                  d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`}
                  fill="none"
                  stroke={tone}
                  strokeOpacity={active ? 0.95 : r.step.virtual || suspect ? 0.8 : 0.4}
                  strokeWidth={active ? 2 : suspect ? 1.7 : 1.2}
                  strokeDasharray={r.step.virtual ? '4 3' : suspect ? '5 2' : undefined}
                  markerEnd={`url(#${ARROW})`}
                />
                {suspect && (
                  <text
                    x={mx}
                    y={(y1 + y2) / 2 + 11}
                    textAnchor="middle"
                    style={{ fill: 'var(--danger)', fontSize: 9, fontFamily: 'var(--mono)' }}
                  >
                    ⚠ 需核对
                  </text>
                )}
                {r.callLine > 0 && (
                  <text
                    x={mx}
                    y={(y1 + y2) / 2 - 4}
                    textAnchor="middle"
                    style={{ fill: active ? 'var(--fg-mid)' : 'var(--fg-faint)', fontSize: 8.5, fontFamily: 'var(--mono)' }}
                  >
                    :{r.callLine}
                  </text>
                )}
              </g>
            );
          })}

          {/* 节点 */}
          {model.rows.map((r) => {
            const bx = xOf(r.depth);
            const by = yOf(r.key);
            const isRoot = r.depth === 0;
            const active = hover === r.key;
            const suspect = r.step.via?.kind === 'suspect';
            const stroke = isRoot ? 'var(--accent)' : suspect ? 'var(--danger)' : r.step.virtual ? 'var(--warn)' : 'var(--line)';
            return (
              <g
                key={`n-${r.key}`}
                onMouseEnter={() => setHover(r.key)}
                onMouseLeave={() => setHover(null)}
                onClick={() => onOpen && onOpen(r.step.file, r.step.line)}
                style={{ cursor: onOpen ? 'pointer' : 'default' }}
              >
                <title>{`${r.step.cls || ''}.${r.step.name} · ${r.step.file}:${r.step.line}${viaHint(r.step.via) ? `\n${viaHint(r.step.via)}` : ''}`}</title>
                <rect
                  x={bx}
                  y={by}
                  width={CT_BOX_W}
                  height={CT_BOX_H}
                  rx={7}
                  fill={active ? 'var(--panel-3)' : 'var(--panel-2)'}
                  stroke={stroke}
                  strokeOpacity={isRoot || active ? 1 : 0.75}
                  strokeWidth={isRoot ? 1.6 : 1}
                  strokeDasharray={r.step.virtual && !isRoot ? '4 3' : undefined}
                />
                <text x={bx + 9} y={by + 13} style={{ fill: isRoot ? 'var(--accent)' : 'var(--fg-faint)', fontSize: 9, fontFamily: 'var(--mono)' }}>
                  {cut(r.step.cls || r.step.label || '', 24)}
                </text>
                <text x={bx + 9} y={by + 28} style={{ fill: isRoot ? 'var(--fg)' : 'var(--fg-mid)', fontSize: 11, fontFamily: 'var(--mono)' }}>
                  {cut(r.step.name, 20)}
                </text>
                {r.chains > 1 && (
                  <text x={bx + CT_BOX_W - 8} y={by + 13} textAnchor="end" style={{ fill: 'var(--accent)', fontSize: 9, fontFamily: 'var(--mono)' }}>
                    ×{r.chains}
                  </text>
                )}
                {r.step.isEntry && <circle cx={bx + CT_BOX_W - 10} cy={by + 27} r={2.6} fill="var(--ok)" />}
                {suspect && (
                  <text x={bx + CT_BOX_W - 8} y={by + 28} textAnchor="end" style={{ fill: 'var(--danger)', fontSize: 11, fontFamily: 'var(--mono)' }}>
                    ⚠
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      <div className="legend">
        <span className="legend-item">根 = 被调用节点，向右逐层展开「谁调用了它」</span>
        <span className="legend-item">
          <span style={{ borderBottom: '1px dashed var(--warn)', paddingBottom: 1 }}>虚线</span> = 接口 / 实现派发（OVERRIDE）
        </span>
        <span className="legend-item" style={{ color: 'var(--danger)' }}>
          ⚠ 红色边 = 这一跳是索引器推断出来的、不可靠（多为外部库调用被错接），请对照源码核对
        </span>
        <span className="legend-item" style={{ color: 'var(--fg-faint)' }}>
          ×n = 经过该节点的链路条数；边上的 :行号 = 调用点；绿点 = 入口方法
        </span>
      </div>
    </div>
  );
}
