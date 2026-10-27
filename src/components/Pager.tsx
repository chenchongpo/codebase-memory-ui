import { useState } from 'react';
import type { PagedMeta } from '../types';

export const PAGE_SIZES = [20, 50, 100, 200, 500];

/** 页码窗口：首页、末页常驻，中间按当前页滑动 */
export function pageWindow(cur: number, total: number, span = 5): (number | '…')[] {
  if (total <= span + 2) return Array.from({ length: total }, (_, i) => i + 1);
  const out: (number | '…')[] = [1];
  const start = Math.max(2, Math.min(cur - Math.floor(span / 2), total - span));
  const end = Math.min(total - 1, start + span - 1);
  if (start > 2) out.push('…');
  for (let p = start; p <= end; p += 1) out.push(p);
  if (end < total - 1) out.push('…');
  out.push(total);
  return out;
}

/**
 * 明细表通用分页条。
 * 由调用方持有 page / pageSize 状态（服务端分页）或自行切片（客户端分页）。
 */
export function Pager({
  meta,
  loading = false,
  unit = '条',
  onPage,
  onPageSize,
}: {
  meta: Pick<PagedMeta, 'page' | 'pageSize' | 'totalPages' | 'filtered' | 'from' | 'to'>;
  loading?: boolean;
  unit?: string;
  onPage: (page: number) => void;
  onPageSize?: (pageSize: number) => void;
}) {
  const [jump, setJump] = useState('');
  const totalPages = Math.max(1, meta.totalPages);
  const goto = (p: number) => onPage(Math.min(Math.max(1, Math.round(p) || 1), totalPages));

  return (
    <div className="pagebar">
      <span className="pinfo">
        第 <b style={{ color: 'var(--fg-mid)' }}>{meta.page}</b> / {totalPages} 页
        {meta.filtered ? ` · 第 ${meta.from}–${meta.to} ${unit}` : ''} · 共 {meta.filtered} {unit}
      </span>
      {onPageSize && (
        <>
          <span style={{ color: 'var(--fg-faint)' }}>每页</span>
          <select
            value={meta.pageSize}
            onChange={(e) => {
              onPageSize(Number(e.target.value));
              onPage(1);
            }}
          >
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </>
      )}

      <span className="grow" />

      <button className="pbtn" disabled={meta.page <= 1 || loading} onClick={() => goto(1)} title="首页">«</button>
      <button className="pbtn" disabled={meta.page <= 1 || loading} onClick={() => goto(meta.page - 1)} title="上一页">‹</button>
      {pageWindow(meta.page, totalPages).map((p, idx) =>
        p === '…' ? (
          <span key={`gap-${idx}`} className="pbtn gap">…</span>
        ) : (
          <button key={p} className={`pbtn ${p === meta.page ? 'on' : ''}`} disabled={loading} onClick={() => goto(p as number)}>
            {p}
          </button>
        )
      )}
      <button className="pbtn" disabled={meta.page >= totalPages || loading} onClick={() => goto(meta.page + 1)} title="下一页">›</button>
      <button className="pbtn" disabled={meta.page >= totalPages || loading} onClick={() => goto(totalPages)} title="末页">»</button>

      <span style={{ color: 'var(--fg-faint)', marginLeft: 4 }}>跳至</span>
      <input
        type="number"
        min={1}
        max={totalPages}
        value={jump}
        onChange={(e) => setJump(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          const n = Number(jump);
          if (Number.isFinite(n) && n >= 1) goto(n);
          setJump('');
        }}
        placeholder={String(meta.page)}
      />
    </div>
  );
}
