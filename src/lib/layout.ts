/**
 * 轻量力导向布局：无第三方依赖，供架构图 / 表关系图使用。
 * 采用「斥力 + 弹簧 + 向心」的经典三力模型，初值按索引铺在同心圆上，
 * 因此同一份数据每次布局结果一致（可复现，便于对比截图）。
 */
export interface LayoutNode { id: string; [k: string]: unknown }
export interface LayoutEdge { s: string; t: string; w: number }

export interface Placed<N> { node: N; x: number; y: number }

export function forceLayout<N extends LayoutNode>(
  nodes: N[],
  edges: LayoutEdge[],
  opts: { width: number; height: number; iters?: number; padding?: number } = { width: 900, height: 520 }
): Placed<N>[] {
  const W = opts.width;
  const H = opts.height;
  const pad = opts.padding ?? 46;
  const iters = opts.iters ?? 320;
  const n = nodes.length;
  if (!n) return [];

  const pos = nodes.map((_, i) => {
    const a = (i / n) * Math.PI * 2;
    const t = 0.55 + ((i * 37) % 100) / 220;
    const r = Math.min(W, H) * 0.34 * t;
    return { x: W / 2 + Math.cos(a) * r, y: H / 2 + Math.sin(a) * r, vx: 0, vy: 0 };
  });

  const idx = new Map(nodes.map((nd, i) => [nd.id, i]));
  const links = edges
    .map((e) => ({ a: idx.get(e.s), b: idx.get(e.t), w: e.w }))
    .filter((l): l is { a: number; b: number; w: number } => l.a !== undefined && l.b !== undefined && l.a !== l.b);

  const k = Math.sqrt((W * H) / Math.max(1, n)) * (n > 40 ? 0.34 : 0.5);
  const maxStep = 14;

  for (let it = 0; it < iters; it += 1) {
    const alpha = 0.85 * (1 - it / iters) + 0.06;

    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        let dx = pos[i].x - pos[j].x;
        let dy = pos[i].y - pos[j].y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) {
          dx = (i - j) || 1;
          dy = 1.7;
          d2 = 1;
        }
        const d = Math.sqrt(d2);
        const f = (k * k) / d2;
        const fx = (dx / d) * f * alpha;
        const fy = (dy / d) * f * alpha;
        pos[i].vx += fx;
        pos[i].vy += fy;
        pos[j].vx -= fx;
        pos[j].vy -= fy;
      }
    }

    for (const l of links) {
      const A = pos[l.a];
      const B = pos[l.b];
      const dx = B.x - A.x;
      const dy = B.y - A.y;
      const d = Math.hypot(dx, dy) || 1;
      const target = k * (0.75 + 0.5 / Math.max(1, l.w));
      const f = (d - target) * 0.085 * alpha;
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      A.vx += fx;
      A.vy += fy;
      B.vx -= fx;
      B.vy -= fy;
    }

    for (let i = 0; i < n; i += 1) {
      pos[i].vx += (W / 2 - pos[i].x) * 0.014 * alpha;
      pos[i].vy += (H / 2 - pos[i].y) * 0.014 * alpha;
      pos[i].vx *= 0.85;
      pos[i].vy *= 0.85;
      pos[i].x += Math.max(-maxStep, Math.min(maxStep, pos[i].vx));
      pos[i].y += Math.max(-maxStep, Math.min(maxStep, pos[i].vy));
    }
  }

  // 收缩到画布可视区
  const xs = pos.map((p) => p.x);
  const ys = pos.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const sx = (W - pad * 2) / Math.max(1, maxX - minX);
  const sy = (H - pad * 2) / Math.max(1, maxY - minY);
  const s = Math.min(sx, sy, 2.4);

  return nodes.map((nd, i) => ({
    node: nd,
    x: pad + (pos[i].x - minX) * s,
    y: pad + (pos[i].y - minY) * s,
  }));
}

/** 圆角矩形路径 */
export function roundRect(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h / 2);
  return `M${x + rr},${y} H${x + w - rr} A${rr},${rr} 0 0 1 ${x + w},${y + rr} V${y + h - rr} A${rr},${rr} 0 0 1 ${x + w - rr},${y + h} H${x + rr} A${rr},${rr} 0 0 1 ${x},${y + h - rr} V${y + rr} A${rr},${rr} 0 0 1 ${x + rr},${y} Z`;
}

/** 二次贝塞尔（带轻微弧度，避免直线堆叠） */
export function curve(x1: number, y1: number, x2: number, y2: number, bend = 0.12): string {
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const dx = x2 - x1;
  const dy = y2 - y1;
  return `M${x1},${y1} Q${mx - dy * bend},${my + dx * bend} ${x2},${y2}`;
}
