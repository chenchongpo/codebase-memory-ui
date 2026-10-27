import { useMemo, useState } from 'react';
import { forceLayout, curve, roundRect } from '../lib/layout';
import { cxColor } from './ui';

export interface LayerNode {
  id: string;
  label: string;
  hint: string;
  files: number;
  methods: number;
  loc: number;
  avgCx: number;
  maxCx: number;
  hotCx: number;
}

const ARROW = 'cbi-arrow';

function ArrowDefs({ color = '#5a6a8a' }: { color?: string }) {
  return (
    <defs>
      <marker id={ARROW} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M 0 0 L 10 5 L 0 10 z" fill={color} />
      </marker>
    </defs>
  );
}

/* ---------------------------------------------------------- 散点图 */

export function ScatterPlot({
  points,
  width = 900,
  height = 330,
  onOpen,
}: {
  points: { x: number; y: number; z: number; cog: number; n: string; c: string; f: string; l: number; t: boolean }[];
  width?: number;
  height?: number;
  onOpen?: (f: string, l: number) => void;
}) {
  const [tip, setTip] = useState<{ x: number; y: number; p: (typeof points)[number] } | null>(null);
  const pad = { l: 44, r: 18, t: 16, b: 32 };
  const maxX = Math.max(10, ...points.map((p) => p.x));
  const maxY = Math.max(4, ...points.map((p) => p.y));
  const logMax = Math.log10(maxX);
  const X = (v: number) => pad.l + ((Math.log10(Math.max(1, v)) / logMax) * (width - pad.l - pad.r));
  const Y = (v: number) => height - pad.b - (v / maxY) * (height - pad.t - pad.b);
  const xTicks = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000].filter((t) => t <= maxX * 1.2);
  const yTicks = [0, Math.round(maxY / 4), Math.round(maxY / 2), Math.round((maxY * 3) / 4), maxY];

  return (
    <div className="chart-wrap">
      <svg className="chart" viewBox={`0 0 ${width} ${height}`} style={{ height }}>
        {yTicks.map((t) => (
          <g key={`y${t}`}>
            <line className="grid-line" x1={pad.l} x2={width - pad.r} y1={Y(t)} y2={Y(t)} />
            <text className="axis-label" x={pad.l - 7} y={Y(t) + 3} textAnchor="end">{t}</text>
          </g>
        ))}
        {xTicks.map((t) => (
          <g key={`x${t}`}>
            <line className="grid-line" x1={X(t)} x2={X(t)} y1={pad.t} y2={height - pad.b} />
            <text className="axis-label" x={X(t)} y={height - pad.b + 14} textAnchor="middle">{t}</text>
          </g>
        ))}
        <text className="axis-label" x={width - pad.r} y={height - 4} textAnchor="end">方法行数（对数轴）→</text>
        <text className="axis-label" x={pad.l - 34} y={pad.t + 4}>圈复杂度</text>
        {points.map((p, i) => (
          <circle
            key={i}
            cx={X(p.x)}
            cy={Y(p.y)}
            r={2.4 + Math.min(3.2, p.z * 0.9)}
            fill={cxColor(p.y)}
            fillOpacity={p.t ? 0.28 : 0.62}
            stroke={p.y > 10 ? cxColor(p.y) : 'none'}
            strokeWidth={p.y > 10 ? 1 : 0}
            onMouseMove={(e) => setTip({ x: e.clientX, y: e.clientY, p })}
            onMouseLeave={() => setTip(null)}
            onClick={() => onOpen?.(p.f, p.l)}
            style={{ cursor: onOpen ? 'pointer' : 'default' }}
          />
        ))}
      </svg>
      {tip && (
        <div className="tooltip" style={{ left: tip.x + 14, top: tip.y + 12 }}>
          <div className="tt">{tip.p.n}{tip.p.t ? ' · 测试' : ''}</div>
          <div className="tr">{tip.p.c}</div>
          <div className="tr">{tip.p.f}:{tip.p.l}</div>
          <div className="tr">复杂度 {tip.p.y} · 行数 {tip.p.x} · 认知 {tip.p.cog} · 循环深度 {tip.p.z}</div>
        </div>
      )}
      <div className="legend">
        {[['1-5', 'var(--cx1)'], ['6-10', 'var(--cx2)'], ['11-20', 'var(--cx3)'], ['21-40', 'var(--cx4)'], ['40+', 'var(--cx5)']].map(([l, c]) => (
          <span className="legend-item" key={l}>
            <i className="legend-dot" style={{ background: c, borderRadius: '50%' }} />
            {l}
          </span>
        ))}
        <span className="legend-item" style={{ marginLeft: 8 }}>点的直径 = 循环嵌套深度</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------ 力导向图 */

export function ForceGraph<N extends { id: string; label: string; sub?: string; size?: number; color?: string }>({
  nodes,
  edges,
  width = 900,
  height = 520,
  minR = 6,
  maxR = 26,
  onPick,
  edgeLabel,
  bend = 0.1,
}: {
  nodes: N[];
  edges: { s: string; t: string; w: number }[];
  width?: number;
  height?: number;
  minR?: number;
  maxR?: number;
  onPick?: (id: string) => void;
  edgeLabel?: (w: number) => string;
  bend?: number;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const placed = useMemo(() => forceLayout(nodes, edges, { width, height }), [nodes, edges, width, height]);
  const pos = useMemo(() => new Map(placed.map((p) => [p.node.id, p])), [placed]);
  const maxSize = Math.max(1, ...nodes.map((n) => n.size ?? 1));
  const radius = (n: N) => {
    const s = (n.size ?? 1) / maxSize;
    return minR + (maxR - minR) * Math.sqrt(s);
  };
  const neighbors = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const e of edges) {
      if (!m.has(e.s)) m.set(e.s, new Set());
      if (!m.has(e.t)) m.set(e.t, new Set());
      m.get(e.s)!.add(e.t);
      m.get(e.t)!.add(e.s);
    }
    return m;
  }, [edges]);
  const dim = (id: string) => hover !== null && id !== hover && !neighbors.get(hover)?.has(id);

  return (
    <div className="chart-wrap">
      <svg className="chart" viewBox={`0 0 ${width} ${height}`} style={{ height }}>
        <ArrowDefs />
        {edges.map((e, i) => {
          const a = pos.get(e.s);
          const b = pos.get(e.t);
          if (!a || !b) return null;
          const active = hover === e.s || hover === e.t;
          const d = curve(a.x, a.y, b.x, b.y, bend);
          const mx = (a.x + b.x) / 2;
          const my = (a.y + b.y) / 2;
          return (
            <g key={i} opacity={dim(e.s) && dim(e.t) ? 0.12 : active ? 1 : 0.5}>
              <path
                d={d}
                fill="none"
                stroke={active ? 'var(--accent)' : '#3a3a52'}
                strokeWidth={Math.min(4, 0.7 + Math.log2(1 + e.w) * 0.66)}
                markerEnd={`url(#${ARROW})`}
              />
              {active && edgeLabel && (
                <text className="edge-label" x={mx} y={my - 4} textAnchor="middle" style={{ fill: 'var(--fg-mid)' }}>{edgeLabel(e.w)}</text>
              )}
            </g>
          );
        })}
        {placed.map(({ node, x, y }) => {
          const r = radius(node);
          return (
            <g
              key={node.id}
              onMouseEnter={() => setHover(node.id)}
              onMouseLeave={() => setHover(null)}
              onClick={() => onPick?.(node.id)}
              style={{ cursor: onPick ? 'pointer' : 'default' }}
              opacity={dim(node.id) ? 0.22 : 1}
            >
              <circle cx={x} cy={y} r={r} fill={node.color ?? 'var(--accent)'} fillOpacity={0.22} stroke={node.color ?? 'var(--accent)'} strokeWidth={1.4} />
              <text className="node-label" x={x} y={y - r - 6} textAnchor="middle">{node.label}</text>
              {node.sub && <text className="node-sub" x={x} y={y - r - 17} textAnchor="middle">{node.sub}</text>}
              {r > 13 && (
                <text x={x} y={y + 4} textAnchor="middle" style={{ fill: 'var(--fg-mid)', fontSize: 10, fontFamily: 'var(--mono)' }}>
                  {node.size}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {hover && pos.get(hover) && (
        <div style={{ position: 'absolute', left: 12, top: 10, fontSize: 11.5, color: 'var(--fg-dim)' }}>
          已选中 <b className="mono" style={{ color: 'var(--fg)' }}>{hover}</b> · 相邻 {neighbors.get(hover)?.size ?? 0} 个
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------- 分层图 */

const LAYER_COLOR: Record<string, string> = {
  L0: '#7aa2ff',
  L1: '#38d9c4',
  L2: '#ffc857',
  L3: '#ff8a5c',
  L4: '#d16bff',
  L5: '#56b6ff',
  LX: '#6b6b80',
};

export function LayerFlow({ layers, flows, width = 940 }: { layers: LayerNode[]; flows: { s: string; t: string; w: number }[]; width?: number }) {
  const [hover, setHover] = useState<string | null>(null);
  const bands = layers.filter((l) => l.files > 0 || l.methods > 0);
  const bandH = 50;
  const gap = 34;
  const top = 26;
  const x0 = 18;
  const bandW = width - 190;
  const H = top + bands.length * (bandH + gap) + 10;
  const yOf = (id: string) => {
    const i = bands.findIndex((b) => b.id === id);
    return top + i * (bandH + gap) + bandH / 2;
  };
  const maxW = Math.max(1, ...flows.map((f) => f.w));
  const shown = flows.filter((f) => f.w >= Math.max(2, maxW * 0.06));

  return (
    <div className="chart-wrap">
      <svg className="chart" viewBox={`0 0 ${width} ${H}`} style={{ height: H }}>
        <ArrowDefs />
        {shown.map((f, i) => {
          const y1 = yOf(f.s);
          const y2 = yOf(f.t);
          if (y1 === undefined || y2 === undefined) return null;
          const active = hover === f.s || hover === f.t;
          const off = (i % 7) * 9;
          const x1 = x0 + bandW;
          const x2 = x0 + bandW;
          const cx = x0 + bandW + 60 + off;
          return (
            <g key={`${f.s}-${f.t}`} opacity={hover && !active ? 0.16 : 1}>
              <path
                d={`M${x1},${y1} C${cx},${y1} ${cx},${y2} ${x2},${y2}`}
                fill="none"
                stroke={active ? 'var(--accent)' : '#3a3a52'}
                strokeWidth={Math.min(3.4, 0.6 + (f.w / maxW) * 3)}
                markerEnd={`url(#${ARROW})`}
              />
              <text className="edge-label" x={cx + 6} y={(y1 + y2) / 2 + 3} style={{ fill: active ? 'var(--fg)' : 'var(--fg-faint)' }}>
                {f.w}
              </text>
            </g>
          );
        })}
        {bands.map((b) => {
          const y = top + bands.indexOf(b) * (bandH + gap);
          const c = LAYER_COLOR[b.id] ?? '#6b6b80';
          return (
            <g key={b.id} onMouseEnter={() => setHover(b.id)} onMouseLeave={() => setHover(null)} style={{ cursor: 'default' }}>
              <path d={roundRect(x0, y, bandW, bandH, 8)} fill={c} fillOpacity={hover === b.id ? 0.16 : 0.09} stroke={c} strokeOpacity={0.55} />
              <rect x={x0} y={y} width={4} height={bandH} rx={2} fill={c} />
              <text x={x0 + 16} y={y + 21} style={{ fill: 'var(--fg)', fontSize: 12.5, fontWeight: 600 }}>{b.label}</text>
              <text x={x0 + 16} y={y + 38} style={{ fill: 'var(--fg-faint)', fontSize: 10.5 }}>{b.hint}</text>
              <text x={x0 + bandW - 14} y={y + 21} textAnchor="end" className="mono" style={{ fill: 'var(--fg-mid)', fontSize: 11 }}>
                {b.files} 文件 · {b.methods} 函数 · {b.loc.toLocaleString()} 行
              </text>
              <text x={x0 + bandW - 14} y={y + 38} textAnchor="end" className="mono" style={{ fill: 'var(--fg-faint)', fontSize: 10.5 }}>
                平均复杂度 {b.avgCx} · 最高 {b.maxCx} · 超 10 的 {b.hotCx} 个
              </text>
            </g>
          );
        })}
        <g>
          <path d={`M4,${yOf(bands[0]?.id ?? 'L0') - 22} L${x0 - 4},${yOf(bands[0]?.id ?? 'L0')}`} stroke="var(--fg-dim)" strokeWidth={1.4} markerEnd={`url(#${ARROW})`} fill="none" />
          <text x={6} y={yOf(bands[0]?.id ?? 'L0') - 28} style={{ fill: 'var(--fg-dim)', fontSize: 10.5 }}>外部请求</text>
        </g>
      </svg>
    </div>
  );
}
