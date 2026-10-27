import { useEffect, useState } from 'react';
import { useApi, shortPath } from '../api';
import type { NodeDetail, SearchHit, Snippet } from '../types';
import { Badge, Card, Empty, ErrorBox, HBars, Kpi, Loading, cxTone } from '../components/ui';
import type { ViewProps } from '../lib/nav';

export default function Search({ project, payload, nav }: ViewProps) {
  const [q, setQ] = useState(payload?.query ?? '');
  const [submitted, setSubmitted] = useState(payload?.query ?? '');
  const [nodeId, setNodeId] = useState<number | null>(payload?.nodeId ?? null);
  const [src, setSrc] = useState<{ file: string; line: number } | null>(
    payload?.file ? { file: payload.file, line: payload.line ?? 1 } : null
  );

  // 从其它视图跳进来时同步定位
  useEffect(() => {
    if (payload?.query !== undefined) {
      setQ(payload.query ?? '');
      setSubmitted(payload.query ?? '');
    }
    if (payload?.nodeId) setNodeId(payload.nodeId);
    if (payload?.file) setSrc({ file: payload.file, line: payload.line ?? 1 });
  }, [payload?.token, payload?.query, payload?.nodeId, payload?.file, payload?.line]);

  const res = useApi<{ query: string; hits: SearchHit[] }>(submitted ? '/search' : null, { project, q: submitted, limit: 60 });
  const detail = useApi<NodeDetail>(nodeId ? '/node' : null, { project, id: nodeId });
  const snippet = useApi<Snippet>(src ? '/source' : null, { project, path: src?.file, start: src?.line, end: src?.line, context: 14 }, [src?.file, src?.line]);

  return (
    <>
      <Card title="全文检索" help="基于图数据库的 FTS5 全文索引，支持前缀匹配；命中后可查看节点详情与源码片段。">
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="search"
            style={{ flex: 1 }}
            placeholder="输入类名 / 方法名 / 文件路径，例如 SysUserController、importExcel、mapper"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && setSubmitted(q)}
          />
          <button className="btn primary" onClick={() => setSubmitted(q)}>检索</button>
          {src && <button className="btn" onClick={() => setSrc(null)}>关闭源码</button>}
        </div>
        {res.data && (
          <div className="tiny dim" style={{ marginTop: 8 }}>
            关键词「{res.data.query}」命中 {res.data.hits.length} 条
          </div>
        )}
      </Card>

      {res.error && <ErrorBox msg={res.error} />}

      <div className="split">
        <Card title="命中结果" hint={res.loading ? '检索中…' : `${res.data?.hits.length ?? 0} 条`} bodyClass="tight">
          <div className="list" style={{ maxHeight: 560 }}>
            {(res.data?.hits ?? []).map((h) => (
              <div key={h.id} className={`list-item ${nodeId === h.id ? 'on' : ''}`} onClick={() => setNodeId(h.id)}>
                <div className="li-main">
                  <div className="li-t">
                    <span className="mono">{h.name}</span>{' '}
                    <Badge tone="mute">{h.label}</Badge>
                    {h.complexity !== null && <Badge tone={cxTone(h.complexity)}>cx {h.complexity}</Badge>}
                  </div>
                  <div className="li-s">{h.cls ? `${h.cls} · ` : ''}{shortPath(h.file, 3)}:{h.line}</div>
                </div>
                <button
                  className="btn sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    setSrc({ file: h.file, line: h.line || 1 });
                  }}
                >
                  源码
                </button>
              </div>
            ))}
            {submitted && !res.loading && !(res.data?.hits.length) && <Empty text="没有命中结果，换个关键词试试" />}
            {!submitted && <Empty text="输入关键词开始检索" />}
          </div>
        </Card>

        <div>
          {detail.loading && <Loading text="正在读取节点邻接…" />}
          {detail.data && (
            <Card
              title={`节点详情 · ${detail.data.node.name}`}
              hint={detail.data.node.qn}
              right={<Badge tone="info">{detail.data.node.label}</Badge>}
            >
              <div className="kpis" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(130px,1fr))' }}>
                <Kpi k="出边" v={detail.data.outgoing.length} color="var(--accent)" d="它指向别人" />
                <Kpi k="入边" v={detail.data.incoming.length} color="var(--accent-2)" d="别人指向它" />
                <Kpi k="定义行" v={detail.data.node.startLine || '—'} color="var(--accent-3)" />
                <Kpi k="复杂度" v={(detail.data.node.props.complexity as number) ?? '—'} color="var(--warn)" />
              </div>

              <div style={{ display: 'grid', gap: 14, marginTop: 14 }}>
                <div>
                  <div className="tiny dim" style={{ marginBottom: 6 }}>出边（按类型）</div>
                  <HBars
                    rows={groupByType(detail.data.outgoing).map((g) => ({ key: g.type, label: g.type, value: g.n, color: 'var(--accent)' }))}
                  />
                </div>
                <div>
                  <div className="tiny dim" style={{ marginBottom: 6 }}>入边（按类型）</div>
                  <HBars
                    rows={groupByType(detail.data.incoming).map((g) => ({ key: g.type, label: g.type, value: g.n, color: 'var(--accent-2)' }))}
                  />
                </div>
              </div>

              <div style={{ marginTop: 14, maxHeight: 240, overflow: 'auto' }}>
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>方向</th>
                      <th>关系</th>
                      <th>节点</th>
                      <th>位置</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...detail.data.outgoing.map((x) => ({ ...x, dir: '→' })), ...detail.data.incoming.map((x) => ({ ...x, dir: '←' }))].slice(0, 60).map((e, i) => (
                      <tr key={i}>
                        <td className="mono dim">{e.dir}</td>
                        <td className="mono tiny">{e.type}</td>
                        <td className="mono">{e.name} <span className="dim tiny">{e.label}</span></td>
                        <td className="mono tiny dim wrap">{shortPath(e.file, 2)}{e.line ? `:${e.line}` : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div style={{ marginTop: 10 }}>
                <button
                  className="btn sm"
                  onClick={() => setSrc({ file: detail.data!.node.file, line: detail.data!.node.startLine || 1 })}
                  disabled={!detail.data.node.file}
                >
                  查看源码片段
                </button>
              </div>
            </Card>
          )}

          {src && (
            <Card
              title={`源码 · ${shortPath(src.file, 3)}`}
              hint={snippet.data ? `第 ${snippet.data.start}–${snippet.data.end} 行 / 共 ${snippet.data.totalLines} 行` : ''}
              right={
                <>
                  <button className="btn sm" onClick={() => setSrc({ file: src.file, line: Math.max(1, src.line - 40) })}>↑ 上翻</button>
                  <button className="btn sm" onClick={() => setSrc({ file: src.file, line: src.line + 40 })}>↓ 下翻</button>
                  <button className="btn sm" onClick={() => nav('complexity')}>复杂度视图</button>
                </>
              }
            >
              {snippet.loading && <Loading />}
              {snippet.error && <ErrorBox msg={snippet.error} />}
              {snippet.data && (
                <div className="code">
                  {snippet.data.lines.map((l) => (
                    <div key={l.n} className={`ln ${l.n === src.line ? 'hl' : ''}`}>
                      <span className="no">{l.n}</span>
                      <span className="tx">{l.t.replace(/\t/g, '    ')}</span>
                    </div>
                  ))}
                </div>
              )}
              {!snippet.loading && !snippet.data && !snippet.error && (
                <Empty text="读不到该文件（可能源码目录不在本机，或路径已被移动）" />
              )}
              <div className="tiny dim" style={{ marginTop: 8 }}>
                源码直接从本地仓库读取（项目 <span className="mono">{project}</span>），行号与图中的定义位置对齐；高亮行即节点定义行。
              </div>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

function groupByType(edges: { type: string }[]): { type: string; n: number }[] {
  const m = new Map<string, number>();
  for (const e of edges) m.set(e.type, (m.get(e.type) ?? 0) + 1);
  return [...m.entries()].map(([type, n]) => ({ type, n })).sort((a, b) => b.n - a.n);
}
