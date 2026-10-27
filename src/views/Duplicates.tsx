import { useMemo, useState } from 'react';
import { useApi, fmtInt } from '../api';
import type { Duplicates as DupData } from '../types';
import { Badge, Card, Empty, ErrorBox, HelpLink, Kpi, Loading, cxTone } from '../components/ui';
import { Pager } from '../components/Pager';
import { csvName, downloadCsv } from '../lib/csv';
import type { ViewProps } from '../lib/nav';

interface Row {
  size: number;
  jaccard: number;
  crossFile: boolean;
  loc: number;
  fp?: string;
  members: { name: string; label: string; cls: string; file: string; line: number; lines: number; complexity: number }[];
}

const PAGE_SIZES = [10, 20, 50, 100];

export default function Duplicates({ project, nav, openSource }: ViewProps) {
  const { data, loading, error } = useApi<DupData>('/duplicates', { project });
  const [tab, setTab] = useState<'cluster' | 'fp'>('cluster');
  const [sel, setSel] = useState(0);
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [crossOnly, setCrossOnly] = useState(false);
  const [minSize, setMinSize] = useState(2);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [fpPage, setFpPage] = useState(1);
  const [fpPageSize, setFpPageSize] = useState(20);

  const clusters: Row[] = useMemo(() => data?.clusters ?? [], [data]);
  const fps: Row[] = useMemo(
    () =>
      (data?.fingerprints ?? []).map((g) => ({
        size: g.size,
        jaccard: 1,
        crossFile: true,
        loc: g.loc,
        fp: g.fp,
        members: g.members.map((m) => ({ ...m, label: 'Method', cls: '' })),
      })),
    [data]
  );

  const all = tab === 'cluster' ? clusters : fps;

  /** 条件查询：函数名 / 类 / 文件 / 指纹 */
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return all.filter((c) => {
      if (c.size < minSize) return false;
      if (crossOnly && !c.crossFile) return false;
      if (!needle) return true;
      if (c.fp && c.fp.toLowerCase().includes(needle)) return true;
      return c.members.some((m) => `${m.name} ${m.cls} ${m.file}`.toLowerCase().includes(needle));
    });
  }, [all, q, minSize, crossOnly]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const curPage = Math.min(page, totalPages);
  const from = (curPage - 1) * pageSize;
  const pageItems = filtered.slice(from, from + pageSize);
  const cur = filtered[Math.min(sel, filtered.length - 1)];

  if (loading && !data) return <Loading text="正在做结构指纹聚类…" />;
  if (error) return <ErrorBox msg={error} />;
  if (!data) return <Empty text="暂无数据" />;

  const s = data.stats;
  const withReset = (fn: () => void) => {
    setPage(1);
    setSel(0);
    fn();
  };

  return (
    <>
      <div className="kpis">
        <Kpi k="重复簇" v={fmtInt(s.clusterCount)} color="var(--warn)" d={`${fmtInt(s.dupMethods)} 个函数参与`} />
        <Kpi k="可回收代码量" v={fmtInt(s.reclaimLoc)} unit="行" color="var(--cx4)" d="同类只留一份的估算值" />
        <Kpi k="结构指纹组" v={fmtInt(s.fpGroups)} color="var(--crit)" d="fp 完全一致的实现" />
        <Kpi k="指纹回收量" v={fmtInt(s.fpReclaimLoc)} unit="行" color="var(--accent-2)" d="复制粘贴的净冗余" />
        <Kpi k="SIMILAR_TO 边" v={fmtInt(s.edgeCount)} color="var(--accent)" d="图数据库中的相似边总数" />
      </div>

      <Card
        title={tab === 'cluster' ? '相似实现簇' : '结构指纹组'}
        help={
          <>
            {tab === 'cluster'
              ? '基于 SIMILAR_TO 边的连通分量，jaccard = 结构相似度（0–1）。'
              : 'fp 字段完全一致 = 同一份代码被复制到多处，合并后可净删冗余。'}
            <HelpLink onClick={() => nav('metrics', { query: 'duplicate', token: Date.now() })}>指纹与相似度口径</HelpLink>
          </>
        }
        right={
          <>
            <div className="seg">
              <button className={tab === 'cluster' ? 'on' : ''} onClick={() => withReset(() => setTab('cluster'))}>
                相似簇 {clusters.length}
              </button>
              <button className={tab === 'fp' ? 'on' : ''} onClick={() => withReset(() => setTab('fp'))}>
                指纹组 {fps.length}
              </button>
            </div>
            <select value={minSize} onChange={(e) => withReset(() => setMinSize(Number(e.target.value)))}>
              {[2, 3, 5, 10].map((n) => (
                <option key={n} value={n}>≥ {n} 处</option>
              ))}
            </select>
            <select value={crossOnly ? '1' : ''} onChange={(e) => withReset(() => setCrossOnly(e.target.value === '1'))}>
              <option value="">全部范围</option>
              <option value="1">仅跨文件</option>
            </select>
            <input
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') withReset(() => setQ(qInput));
              }}
              placeholder="函数 / 类 / 文件"
              style={{ width: 150 }}
            />
            <button className="btn sm" onClick={() => withReset(() => setQ(qInput))}>查询</button>
            {(q || crossOnly || minSize !== 2) && (
              <button
                className="btn sm"
                onClick={() =>
                  withReset(() => {
                    setQ('');
                    setQInput('');
                    setCrossOnly(false);
                    setMinSize(2);
                  })
                }
              >
                重置
              </button>
            )}
            <button
              className="btn sm"
              title="按当前筛选条件导出全量结果"
              onClick={() =>
                downloadCsv(
                  csvName(tab === 'cluster' ? '重复实现簇' : '结构指纹组', project),
                  ['组号', tab === 'cluster' ? '相似度' : '指纹', '规模', '跨文件', '合计行数', '可省行数', '函数', '所属类', '文件', '行号', '行数', '复杂度'],
                  filtered.flatMap((c, i) =>
                    c.members.map((m) => [
                      i + 1,
                      tab === 'cluster' ? c.jaccard.toFixed(3) : c.fp ?? '',
                      c.size,
                      c.crossFile ? '是' : '否',
                      c.loc,
                      c.loc - (c.members[0]?.lines ?? 0),
                      m.name, m.cls, m.file, m.line, m.lines, m.complexity,
                    ])
                  )
                )
              }
            >
              导出 CSV
            </button>
          </>
        }
        bodyClass="tight"
      >
        {filtered.length === 0 ? (
          <Empty text={q || crossOnly || minSize !== 2 ? '当前筛选条件下没有命中' : '未发现重复实现'} />
        ) : (
          <div className="split" style={{ gap: 0 }}>
            <div style={{ borderRight: '1px solid var(--line)', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
              <div className="list" style={{ maxHeight: 520 }}>
                {pageItems.map((c, i) => {
                  const idx = from + i;
                  return (
                    <div key={idx} className={`list-item ${idx === sel ? 'on' : ''}`} onClick={() => setSel(idx)}>
                      <span className="li-n">#{idx + 1}</span>
                      <div className="li-main">
                        <div className="li-t">
                          {c.members[0]?.name ?? '—'}
                          {c.size > 1 ? ` 等 ${c.size} 处` : ''}
                          {c.crossFile ? '' : ' · 同文件'}
                        </div>
                        <div className="li-s">{c.members[0]?.file?.split('/').slice(-2).join('/')}</div>
                      </div>
                      <span className="li-n">
                        <Badge tone={c.size >= 5 ? 'danger' : 'warn'}>{c.size}×</Badge>
                      </span>
                      <span className="li-n dim">{c.loc} 行</span>
                    </div>
                  );
                })}
              </div>
              <div className="pagebar mini">
                <button className="pbtn" disabled={curPage <= 1} onClick={() => { setPage(curPage - 1); setSel((curPage - 2) * pageSize); }} title="上一页">‹</button>
                <span className="pinfo">{curPage} / {totalPages} · {filtered.length} 组</span>
                <button className="pbtn" disabled={curPage >= totalPages} onClick={() => { setPage(curPage + 1); setSel(curPage * pageSize); }} title="下一页">›</button>
                <span className="grow" />
                <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); setSel(0); }}>
                  {PAGE_SIZES.map((n) => (
                    <option key={n} value={n}>{n} / 页</option>
                  ))}
                </select>
              </div>
            </div>

            <div style={{ padding: 14, minHeight: 200, minWidth: 0 }}>
              {!cur ? (
                <Empty text="请选择左侧条目" />
              ) : (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
                    <b style={{ fontSize: 13 }}>#{filtered.indexOf(cur) + 1}</b>
                    <Badge tone="warn">{cur.size} 处重复</Badge>
                    {tab === 'cluster' ? (
                      <Badge tone="info">jaccard {cur.jaccard.toFixed(3)}</Badge>
                    ) : (
                      <Badge tone="info">fp {cur.fp?.slice(0, 16)}</Badge>
                    )}
                    <Badge tone={cur.crossFile ? 'danger' : 'mute'}>{cur.crossFile ? '跨文件' : '同文件内'}</Badge>
                    <span className="tiny dim">合计 {cur.loc} 行，保留一份可省 {cur.loc - (cur.members[0]?.lines ?? 0)} 行</span>
                  </div>
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>函数</th>
                        <th>所属类</th>
                        <th className="num">行数</th>
                        <th className="num">复杂度</th>
                        <th>位置</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cur.members.map((m, i) => (
                        <tr key={i}>
                          <td className="mono">{m.name}</td>
                          <td className="mono dim">{m.cls || '—'}</td>
                          <td className="num dim">{m.lines}</td>
                          <td className="num"><Badge tone={cxTone(m.complexity)}>{m.complexity}</Badge></td>
                          <td>
                            <span className="mono tiny" style={{ color: 'var(--accent)', cursor: 'pointer' }} onClick={() => openSource(m.file, m.line)} title={m.file}>
                              {m.file}:{m.line}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="tiny dim" style={{ marginTop: 10 }}>
                    处置建议：同文件内的先抽公共方法；跨模块的先判断是否属于历史复制，再决定抽公共组件还是走依赖下沉。
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </Card>

      {tab === 'fp' && fps.length > 0 && (
        <Card title="指纹明细" bodyClass="tight">
          <div style={{ maxHeight: 420, overflow: 'auto' }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 52 }}>#</th>
                  <th>指纹</th>
                  <th className="num">处数</th>
                  <th className="num">行数</th>
                  <th>首个位置</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice((fpPage - 1) * fpPageSize, (fpPage - 1) * fpPageSize + fpPageSize).map((g, i) => (
                  <tr key={g.fp ?? i}>
                    <td className="num dim">{(fpPage - 1) * fpPageSize + i + 1}</td>
                    <td className="mono tiny">{g.fp?.slice(0, 18)}</td>
                    <td className="num"><Badge tone="warn">{g.size}</Badge></td>
                    <td className="num dim">{g.loc}</td>
                    <td>
                      <span className="mono tiny" style={{ color: 'var(--accent)', cursor: 'pointer' }} onClick={() => openSource(g.members[0].file, g.members[0].line)}>
                        {g.members[0].file}:{g.members[0].line}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager
            meta={{
              page: Math.min(fpPage, Math.max(1, Math.ceil(filtered.length / fpPageSize))),
              pageSize: fpPageSize,
              totalPages: Math.max(1, Math.ceil(filtered.length / fpPageSize)),
              filtered: filtered.length,
              from: filtered.length ? (fpPage - 1) * fpPageSize + 1 : 0,
              to: Math.min(filtered.length, fpPage * fpPageSize),
            }}
            onPage={setFpPage}
            onPageSize={(n) => {
              setFpPageSize(n);
              setFpPage(1);
            }}
          />
        </Card>
      )}
    </>
  );
}
