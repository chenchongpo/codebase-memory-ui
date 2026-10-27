import { useMemo, useState } from 'react';
import { apiGet, useApi, fmtInt } from '../api';
import type { DeadCodeData, DeadRisk, DeadRow } from '../types';
import { Badge, Card, Empty, ErrorBox, HelpLink, Kpi, Loading } from '../components/ui';
import { Pager } from '../components/Pager';
import type { ViewProps } from '../lib/nav';

const RISK_META: Record<DeadRisk, { label: string; tone: 'ok' | 'warn' | 'danger'; hint: string }> = {
  low: { label: '低风险', tone: 'ok', hint: '无调用、无注解、非框架组件，可优先纳入删除批次' },
  review: { label: '需复核', tone: 'warn', hint: '框架组件 / 带注解 / 动态语言，需确认调用方' },
  keep: { label: '不建议删', tone: 'danger', hint: '入口、接口契约或运行时反向调用，静态图看不到' },
};

const KIND_LABEL: Record<string, string> = {
  Method: '方法',
  Function: '函数',
  Class: '类',
  Interface: '接口',
  Enum: '枚举',
  Field: '字段',
  Variable: '变量',
};

const KINDS = ['Method', 'Function', 'Class', 'Interface', 'Enum', 'Field', 'Variable'];

export default function DeadCode({ project, payload, nav, openSource }: ViewProps) {
  const [mod, setMod] = useState(payload?.module ?? '');
  const [kind, setKind] = useState('');
  const [risk, setRisk] = useState('');
  const [sort, setSort] = useState('loc');
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  const { data, loading, error } = useApi<DeadCodeData>('/deadcode', {
    project,
    module: mod,
    kind,
    risk,
    q,
    sort,
    page,
    pageSize,
  });

  const modules = data?.modules ?? [];
  const rows = data?.rows ?? [];

  /** 任一筛选条件变化都要回到第 1 页 */
  const withReset = (fn: () => void) => {
    setPage(1);
    fn();
  };

  const moduleMax = useMemo(
    () => Math.max(1, ...modules.map((m) => m.low + m.review + m.keep)),
    [modules]
  );

  const reset = () => {
    setMod('');
    setKind('');
    setRisk('');
    setQ('');
    setQInput('');
    setSort('loc');
    setPage(1);
  };

  if (!data) {
    if (error) return <ErrorBox msg={error} />;
    return <Loading text="正在扫描无引用代码…" />;
  }

  const s = data.summary;
  const active = mod || kind || risk || q;

  return (
    <>
      <div className="kpis">
        <Kpi
          k="扫描节点"
          v={fmtInt(s.scannedTotal)}
          d={`已排除测试代码 ${fmtInt(s.testExcluded)} 个${s.ruleExcluded ? ` · 规则排除 ${fmtInt(s.ruleExcluded)} 个` : ''}`}
        />
        <Kpi k="无引用总数" v={fmtInt(s.deadTotal)} color="var(--warn)" d={`占扫描节点 ${(s.rate * 100).toFixed(1)}%`} />
        <Kpi k="低风险可删" v={fmtInt(s.byRisk.low)} color="var(--ok)" d="可直接纳入删除批次" />
        <Kpi k="需复核" v={fmtInt(s.byRisk.review)} color="var(--cx4)" d="须确认调用方后处置" />
        <Kpi k="不建议删" v={fmtInt(s.byRisk.keep)} color="var(--danger)" d="入口 / 契约 / 运行时调用" />
        <Kpi k="可回收行数" v={fmtInt(s.reclaimLocLow)} unit="行" color="var(--accent)" d={`全部无引用方法合计 ${fmtInt(s.reclaimLocAll)} 行`} />
      </div>

      <Card
        title="按模块汇总"
        help="点任一行可筛选下方明细；占比 = 无引用节点 / 该模块扫描节点。"
        bodyClass="tight"
        right={active ? <button className="btn sm" onClick={reset}>重置筛选</button> : null}
      >
        <div style={{ maxHeight: 320, overflow: 'auto' }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>模块</th>
                <th className="num">扫描</th>
                <th className="num">无引用</th>
                <th>占比</th>
                <th className="num">低风险</th>
                <th className="num">需复核</th>
                <th className="num">不建议删</th>
                <th className="num">可回收行</th>
              </tr>
            </thead>
            <tbody>
              {modules.map((m) => {
                const dead = m.low + m.review + m.keep;
                const on = mod === m.module;
                return (
                  <tr
                    key={m.module}
                    onClick={() => withReset(() => setMod(on ? '' : m.module))}
                    style={{ cursor: 'pointer', background: on ? 'rgba(122,162,255,.08)' : undefined }}
                  >
                    <td className="mono">
                      {on ? '▸ ' : ''}
                      {m.module}
                    </td>
                    <td className="num dim">{fmtInt(m.scanned)}</td>
                    <td className="num">{fmtInt(dead)}</td>
                    <td style={{ minWidth: 120 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                        <div style={{ flex: 1, height: 6, background: 'var(--panel-3)', borderRadius: 4, overflow: 'hidden' }}>
                          <div
                            style={{
                              width: `${Math.max(1, (dead / moduleMax) * 100)}%`,
                              height: '100%',
                              background: 'var(--warn)',
                              opacity: 0.85,
                            }}
                          />
                        </div>
                        <span className="mono tiny dim" style={{ flex: 'none', width: 42, textAlign: 'right' }}>
                          {m.scanned ? ((dead / m.scanned) * 100).toFixed(1) : '0.0'}%
                        </span>
                      </div>
                    </td>
                    <td className="num">{m.low ? <Badge tone="ok">{fmtInt(m.low)}</Badge> : <span className="dim">0</span>}</td>
                    <td className="num">{m.review ? <Badge tone="warn">{fmtInt(m.review)}</Badge> : <span className="dim">0</span>}</td>
                    <td className="num">{m.keep ? <Badge tone="danger">{fmtInt(m.keep)}</Badge> : <span className="dim">0</span>}</td>
                    <td className="num dim">{fmtInt(m.loc)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <Card
        title="无引用明细"
        help={
          <>
            「无引用」= 没有任何 CALLS / USAGE / IMPORTS / OVERRIDE 入边。测试代码已排除 {fmtInt(s.testExcluded)} 个，
            字段与变量因引用边不完整统一归「需复核」（{fmtInt(s.lowConfidence)} 条）。
            <HelpLink onClick={() => nav('metrics', { query: 'refs', token: Date.now() })}>判定口径与删前盲区</HelpLink>
          </>
        }
        hint={`共 ${fmtInt(data.filtered)} 条${data.from ? ` · 当前第 ${fmtInt(data.from)}–${fmtInt(data.to)} 条` : ''}${loading ? ' · 更新中' : ''}`}
        bodyClass="tight"
        right={
          <>
            <select value={mod} onChange={(e) => withReset(() => setMod(e.target.value))}>
              <option value="">全部模块</option>
              {modules.map((m) => (
                <option key={m.module} value={m.module}>{m.module}</option>
              ))}
            </select>
            <select value={kind} onChange={(e) => withReset(() => setKind(e.target.value))}>
              <option value="">全部类型</option>
              {KINDS.filter((k) => (s.byKind.find((x) => x.kind === k)?.scanned ?? 0) > 0).map((k) => (
                <option key={k} value={k}>{KIND_LABEL[k] ?? k}</option>
              ))}
            </select>
            <select value={risk} onChange={(e) => withReset(() => setRisk(e.target.value))}>
              <option value="">全部分级</option>
              <option value="low">低风险</option>
              <option value="review">需复核</option>
              <option value="keep">不建议删</option>
            </select>
            <select value={sort} onChange={(e) => setSort(e.target.value)}>
              <option value="loc">按行数排序</option>
              <option value="complexity">按复杂度排序</option>
              <option value="name">按名称排序</option>
              <option value="module">按模块排序</option>
              <option value="risk">按分级排序</option>
            </select>
            <input
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') withReset(() => setQ(qInput));
              }}
              placeholder="名称 / 类 / 文件"
              style={{ width: 168 }}
            />
            <button className="btn sm" onClick={() => withReset(() => setQ(qInput))}>查询</button>
            <button
              className="btn sm"
              title="按当前筛选条件导出全量结果"
              onClick={() =>
                void exportCsv(project, { module: mod, kind, risk, q, sort }).catch((e: Error) =>
                  window.alert(`导出失败：${e.message}`)
                )
              }
            >
              导出 CSV
            </button>
          </>
        }
      >
        {rows.length === 0 ? (
          <Empty text={active ? '当前筛选条件下没有命中' : '未发现无引用代码'} />
        ) : (
          <>
            <div style={{ maxHeight: 620, overflow: 'auto' }}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th style={{ width: 52 }}>#</th>
                    <th style={{ width: 62 }}>类型</th>
                    <th>名称</th>
                    <th>所属类</th>
                    <th>模块</th>
                    <th className="num">行数</th>
                    <th>位置</th>
                    <th style={{ width: 84 }}>分级</th>
                    <th>判定理由</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={`${r.id}`}>
                      <td className="num dim">{data.from + i}</td>
                      <td className="dim tiny">{KIND_LABEL[r.kind] ?? r.kind}</td>
                      <td className="mono">
                        {r.name}
                        {r.confidence === 'low' && <span className="chip" style={{ marginLeft: 6 }}>低置信</span>}
                      </td>
                      <td className="mono dim">{r.cls || '—'}</td>
                      <td className="mono dim tiny">{r.module}</td>
                      <td className="num dim">{r.loc}</td>
                      <td>
                        <span
                          className="mono tiny"
                          style={{ color: 'var(--accent)', cursor: 'pointer' }}
                          onClick={() => openSource(r.file, r.line)}
                          title={r.file}
                        >
                          {r.file.split('/').slice(-2).join('/')}:{r.line}
                        </span>
                      </td>
                      <td>
                        <Badge tone={RISK_META[r.risk].tone}>{RISK_META[r.risk].label}</Badge>
                      </td>
                      <td className="tiny dim">{r.reasons.join('；')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <Pager meta={data} loading={loading} onPage={setPage} onPageSize={(n) => setPageSize(n)} />
          </>
        )}
      </Card>

      <Card title="分级口径" help="三档判定标准；「无引用」= 无 CALLS / USAGE / IMPORTS / OVERRIDE 入边，DEFINES、CONTAINS_* 等结构边不算引用。">
          <table className="tbl">
            <tbody>
              {(Object.keys(RISK_META) as DeadRisk[]).map((k) => (
                <tr key={k}>
                  <td style={{ width: 90 }}><Badge tone={RISK_META[k].tone}>{RISK_META[k].label}</Badge></td>
                  <td className="tiny dim">{RISK_META[k].hint}</td>
                  <td className="num mono" style={{ width: 70 }}>{fmtInt(s.byRisk[k])}</td>
                </tr>
              ))}
            </tbody>
          </table>
      </Card>

      {s.ruleExcluded > 0 && (
        <Card
          title="排除规则命中"
          help="规则在「配置 · 无引用排除规则」里维护；命中即整条排除，不计入扫描节点。"
          bodyClass="tight"
        >
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: '0 0 10px' }}>
            {(s.excludedByRule ?? []).map((r) => (
              <span key={r.pattern} className="chip mono">
                {r.pattern} × {r.count}
              </span>
            ))}
          </div>
          <div style={{ maxHeight: 260, overflow: 'auto' }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>名称</th>
                  <th>类型</th>
                  <th>文件</th>
                  <th>命中规则</th>
                </tr>
              </thead>
              <tbody>
                {(s.excludedSamples ?? []).map((x, i) => (
                  <tr key={`${x.file}:${x.line}:${i}`}>
                    <td className="mono">{x.name}</td>
                    <td className="tiny dim">{x.kind}</td>
                    <td className="mono tiny dim wrap">
                      {x.file}
                      {x.line ? `:${x.line}` : ''}
                    </td>
                    <td className="mono tiny dim">{x.pattern}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {(s.excludedSamples?.length ?? 0) >= 30 && (
            <div className="cfg-hint">仅显示前 30 条命中样本。</div>
          )}
        </Card>
      )}

    </>
  );
}

/** 按当前筛选条件取全量结果并导出 CSV（带 BOM，Excel 直接可读） */
async function exportCsv(
  project: string,
  filter: { module: string; kind: string; risk: string; q: string; sort: string }
) {
  const d = await apiGet<DeadCodeData>('/deadcode', { project, ...filter, all: 1 });
  const rows: DeadRow[] = d.rows;
  const head = ['类型', '名称', '所属类', '模块', '包', '文件', '起始行', '结束行', '行数', '分级', '置信度', '判定理由'];
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const body = rows.map((r) =>
    [r.kind, r.name, r.cls, r.module, r.pkg, r.file, r.line, r.endLine, r.loc, RISK_META[r.risk].label, r.confidence, r.reasons.join('；')]
      .map(esc)
      .join(',')
  );
  const csv = `\ufeff${[head.map(esc).join(','), ...body].join('\r\n')}`;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `无引用代码_${project}_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
