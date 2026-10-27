import React, { useEffect, useRef, useState } from 'react';

/* ------------------------------------------------------------------ 基础 */

/** 「?」帮助钮：点击弹出说明，点别处关闭 */
export function Help({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <span className="help-wrap" ref={ref}>
      <button
        type="button"
        className={`help-btn ${open ? 'on' : ''}`}
        aria-label="查看说明"
        onClick={() => setOpen((v) => !v)}
      >
        ?
      </button>
      {open && <span className="help-pop">{children}</span>}
    </span>
  );
}

/**
 * 「查看指标口径 ›」跳转入口。
 *
 * 各视图原来各自带一大段散文式说明，同一个概念在多处重复且口吻不一。
 * 现在正文只留「怎么用」，口径统一收进「指标说明」页，由这个入口带锚点跳过去。
 */
export function HelpLink({ onClick, children = '查看指标口径' }: { onClick: () => void; children?: React.ReactNode }) {
  return (
    <button type="button" className="link-btn" onClick={onClick}>
      {children} ›
    </button>
  );
}

export function Card({
  title,
  hint,
  help,
  right,
  children,
  bodyClass = '',
  style,
}: {
  title?: React.ReactNode;
  hint?: React.ReactNode;
  /** 有价值的静态说明：标题旁「?」点击查看 */
  help?: React.ReactNode;
  right?: React.ReactNode;
  children: React.ReactNode;
  bodyClass?: string;
  style?: React.CSSProperties;
}) {
  return (
    <section className="card" style={style}>
      {(title || right) && (
        <header className="card-head">
          {title && <h3>{title}</h3>}
          {help && <Help>{help}</Help>}
          {hint && <span className="hint">{hint}</span>}
          {right && <div className="right">{right}</div>}
        </header>
      )}
      <div className={`card-body ${bodyClass}`}>{children}</div>
    </section>
  );
}

export function Kpi({ k, v, unit, d, color }: { k: string; v: React.ReactNode; unit?: string; d?: React.ReactNode; color?: string }) {
  return (
    <div className="kpi" style={{ ['--kc' as string]: color ?? 'var(--accent)' }}>
      <div className="k">{k}</div>
      <div className="v">
        {v}
        {unit && <span className="u">{unit}</span>}
      </div>
      {d && <div className="d">{d}</div>}
    </div>
  );
}

export function Badge({ tone = 'mute', children }: { tone?: 'ok' | 'info' | 'warn' | 'danger' | 'crit' | 'mute'; children: React.ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function Loading({ text = '加载中…' }: { text?: string }) {
  return <div className="loading">{text}</div>;
}

export function ErrorBox({ msg }: { msg: string }) {
  return (
    <div className="err">
      接口返回错误：<code>{msg}</code>
    </div>
  );
}

export function Empty({ text }: { text: string }) {
  return <div className="empty">{text}</div>;
}

/* ------------------------------------------------------------ 复杂度分档 */

export const CX_ORDER = ['1-5', '6-10', '11-20', '21-40', '40+'] as const;
export const CX_LABEL: Record<string, string> = {
  '1-5': '1–5 简单',
  '6-10': '6–10 中等',
  '11-20': '11–20 偏复杂',
  '21-40': '21–40 复杂',
  '40+': '>40 极复杂',
};
export const CX_COLOR: Record<string, string> = {
  '1-5': 'var(--cx1)',
  '6-10': 'var(--cx2)',
  '11-20': 'var(--cx3)',
  '21-40': 'var(--cx4)',
  '40+': 'var(--cx5)',
};

export function bucketOf(v: number): string {
  return v <= 5 ? '1-5' : v <= 10 ? '6-10' : v <= 20 ? '11-20' : v <= 40 ? '21-40' : '40+';
}
export function cxColor(v: number): string {
  return CX_COLOR[bucketOf(v)];
}
export function cxTone(v: number): 'ok' | 'info' | 'warn' | 'danger' | 'crit' {
  return (['ok', 'info', 'warn', 'danger', 'crit'] as const)[CX_ORDER.indexOf(bucketOf(v) as (typeof CX_ORDER)[number])];
}

/* ------------------------------------------------------------------ 图表 */

export function Legend({ items }: { items: { label: string; color: string; value?: React.ReactNode }[] }) {
  return (
    <div className="legend">
      {items.map((it) => (
        <span className="legend-item" key={it.label}>
          <i className="legend-dot" style={{ background: it.color }} />
          {it.label}
          {it.value !== undefined && <b className="mono" style={{ color: 'var(--fg-mid)', fontWeight: 500 }}>{it.value}</b>}
        </span>
      ))}
    </div>
  );
}

/** 纵向直方图：按分档展示函数数量 */
export function Histogram({
  data,
  height = 168,
  colors,
  onPick,
}: {
  data: { key: string; label: string; value: number }[];
  height?: number;
  colors?: Record<string, string>;
  onPick?: (key: string) => void;
}) {
  const [tip, setTip] = useState<{ x: number; y: number; d: (typeof data)[number] } | null>(null);
  const max = Math.max(1, ...data.map((d) => d.value));
  const W = 680;
  const H = height;
  const padB = 34;
  const padT = 18;
  const gap = 14;
  const bw = (W - gap * (data.length - 1)) / data.length;

  return (
    <div className="chart-wrap">
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} style={{ height: H }}>
        {[0, 0.25, 0.5, 0.75, 1].map((f) => {
          const y = padT + (H - padT - padB) * (1 - f);
          const val = Math.round(max * f);
          return (
            <g key={f}>
              <line className="grid-line" x1={0} x2={W} y1={y} y2={y} />
              <text className="axis-label" x={2} y={y - 3}>{val}</text>
            </g>
          );
        })}
        {data.map((d, i) => {
          const h = ((H - padT - padB) * d.value) / max;
          const x = i * (bw + gap);
          const y = H - padB - h;
          const fill = colors?.[d.key] ?? 'var(--accent)';
          return (
            <g
              key={d.key}
              onMouseMove={(e) => setTip({ x: e.clientX, y: e.clientY, d })}
              onMouseLeave={() => setTip(null)}
              onClick={() => onPick?.(d.key)}
              style={{ cursor: onPick ? 'pointer' : 'default' }}
            >
              <rect x={x} y={padT} width={bw} height={H - padT - padB} fill="transparent" />
              <rect x={x} y={y} width={bw} height={Math.max(1, h)} rx={4} fill={fill} opacity={0.9} />
              <text className="axis-label" x={x + bw / 2} y={y - 5} textAnchor="middle" style={{ fill: 'var(--fg-mid)' }}>
                {d.value}
              </text>
              <text className="axis-label" x={x + bw / 2} y={H - padB + 15} textAnchor="middle">{d.label}</text>
            </g>
          );
        })}
        <line className="axis" x1={0} x2={W} y1={H - padB} y2={H - padB} />
      </svg>
      {tip && (
        <div className="tooltip" style={{ left: tip.x + 14, top: tip.y + 10 }}>
          <div className="tt">{tip.d.label}</div>
          <div className="tr">函数数 {tip.d.value.toLocaleString()} · 占比 {((tip.d.value / data.reduce((a, b) => a + b.value, 0)) * 100).toFixed(1)}%</div>
        </div>
      )}
    </div>
  );
}

/** 横向条形图：带名称、数值、可点击、可显示占比条 */
export function HBars({
  rows,
  max,
  color = 'var(--accent)',
  onPick,
  unit = '',
}: {
  rows: { key: string; label: string; value: number; sub?: string; color?: string }[];
  max?: number;
  color?: string;
  onPick?: (key: string) => void;
  unit?: string;
}) {
  const top = Math.max(1, max ?? Math.max(...rows.map((r) => r.value)));
  return (
    <div style={{ display: 'grid', gap: 7 }}>
      {rows.map((r) => (
        <div
          key={r.key}
          onClick={() => onPick?.(r.key)}
          style={{ cursor: onPick ? 'pointer' : 'default' }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 11.5, marginBottom: 3 }}>
            <span className="mono" style={{ color: 'var(--fg-mid)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {r.label}
            </span>
            <span className="mono" style={{ color: 'var(--fg-dim)', flex: 'none' }}>
              {r.value.toLocaleString()}
              {unit}
              {r.sub ? <span style={{ color: 'var(--fg-faint)' }}> · {r.sub}</span> : null}
            </span>
          </div>
          <div style={{ height: 6, background: 'var(--panel-3)', borderRadius: 4, overflow: 'hidden' }}>
            <div
              style={{
                width: `${Math.max(1.5, (r.value / top) * 100)}%`,
                height: '100%',
                background: r.color ?? color,
                borderRadius: 4,
                opacity: 0.85,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/** 堆叠条：展示每个模块的复杂度构成 */
export function StackedBars({
  rows,
  keys,
  colors,
  onPick,
}: {
  rows: { label: string; total: number; parts: Record<string, number> }[];
  keys: readonly string[];
  colors: Record<string, string>;
  onPick?: (label: string) => void;
}) {
  const max = Math.max(1, ...rows.map((r) => r.total));
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {rows.map((r) => (
        <div key={r.label} onClick={() => onPick?.(r.label)} style={{ cursor: onPick ? 'pointer' : 'default' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, marginBottom: 3 }}>
            <span className="mono" style={{ color: 'var(--fg-mid)' }}>{r.label}</span>
            <span className="mono" style={{ color: 'var(--fg-dim)' }}>{r.total.toLocaleString()} 个函数</span>
          </div>
          <div style={{ display: 'flex', height: 12, borderRadius: 4, overflow: 'hidden', background: 'var(--panel-3)', width: `${(r.total / max) * 100}%`, minWidth: 40 }}>
            {keys.map((k) =>
              r.parts[k] ? (
                <div
                  key={k}
                  title={`${k}: ${r.parts[k]}`}
                  style={{ width: `${(r.parts[k] / r.total) * 100}%`, background: colors[k], opacity: 0.9 }}
                />
              ) : null
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/** 环形占比 */
export function Donut({
  slices,
  size = 128,
  thickness = 14,
  center,
}: {
  slices: { label: string; value: number; color: string }[];
  size?: number;
  thickness?: number;
  center?: React.ReactNode;
}) {
  const total = slices.reduce((a, s) => a + s.value, 0) || 1;
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  let acc = 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ flex: 'none' }}>
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--panel-3)" strokeWidth={thickness} />
          {slices.map((s) => {
            const len = (s.value / total) * c;
            const el = (
              <circle
                key={s.label}
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke={s.color}
                strokeWidth={thickness}
                strokeDasharray={`${len} ${c - len}`}
                strokeDashoffset={-acc}
                strokeLinecap="butt"
              />
            );
            acc += len;
            return el;
          })}
        </g>
        {center && (
          <text x={size / 2} y={size / 2 + 5} textAnchor="middle" style={{ fill: 'var(--fg)', fontSize: 18, fontWeight: 650, fontFamily: 'var(--mono)' }}>
            {center}
          </text>
        )}
      </svg>
      <div style={{ display: 'grid', gap: 5 }}>
        {slices.map((s) => (
          <div key={s.label} className="legend-item">
            <i className="legend-dot" style={{ background: s.color }} />
            <span style={{ minWidth: 78 }}>{s.label}</span>
            <b className="mono" style={{ color: 'var(--fg-mid)', fontWeight: 500 }}>{s.value.toLocaleString()}</b>
            <span className="mono" style={{ color: 'var(--fg-faint)' }}>{((s.value / total) * 100).toFixed(1)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 文件路径 + 行号，点击可在「检索」中打开 */
export function Loc({ file, line, onOpen }: { file: string; line?: number; onOpen?: (f: string, l: number) => void }) {
  if (!file) return <span className="dim">—</span>;
  return (
    <span
      className="mono tiny"
      style={{ color: onOpen ? 'var(--accent)' : 'var(--fg-dim)', cursor: onOpen ? 'pointer' : 'default' }}
      title={file}
      onClick={() => onOpen?.(file, line ?? 1)}
    >
      {file}
      {line ? <span style={{ color: 'var(--fg-faint)' }}>:{line}</span> : null}
    </span>
  );
}
