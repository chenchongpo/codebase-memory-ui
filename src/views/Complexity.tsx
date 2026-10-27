import { useMemo, useState } from 'react';
import { apiGet, useApi, fmtInt } from '../api';
import type { ComplexityData } from '../types';
import { Badge, Card, CX_COLOR, CX_LABEL, CX_ORDER, Empty, ErrorBox, HelpLink, Histogram, Kpi, Loading, cxTone } from '../components/ui';
import { ScatterPlot } from '../components/graphs';
import { Pager } from '../components/Pager';
import { csvName, downloadCsv } from '../lib/csv';
import type { ViewProps } from '../lib/nav';

const SORTS = [
  { id: 'complexity', label: '按复杂度排序' },
  { id: 'cognitive', label: '按认知复杂度排序' },
  { id: 'lines', label: '按行数排序' },
  { id: 'loop', label: '按循环深度排序' },
  { id: 'name', label: '按名称排序' },
  { id: 'module', label: '按模块排序' },
];

const KINDS = [
  { id: 'Method', label: '方法' },
  { id: 'Function', label: '函数' },
];

export default function Complexity({ project, payload, nav, openSource }: ViewProps) {
  const [mod, setMod] = useState<string>(payload?.module ?? '');
  const [bucket, setBucket] = useState<string>('');
  const [kind, setKind] = useState<string>('');
  const [test, setTest] = useState<string>('');
  const [sort, setSort] = useState<string>('complexity');
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  const { data, loading, error } = useApi<ComplexityData>('/complexity', {
    project,
    module: mod,
    bucket,
    kind,
    test,
    sort,
    q,
    page,
    pageSize,
  });

  const modules = useMemo(() => (data?.modules ?? []).map((m) => m.module), [data]);

  /** 任一筛选条件变化都要回到第 1 页 */
  const withReset = (fn: () => void) => {
    setPage(1);
    fn();
  };

  const reset = () => {
    setMod('');
    setBucket('');
    setKind('');
    setTest('');
    setQ('');
    setQInput('');
    setSort('complexity');
    setPage(1);
  };

  if (!data) {
    if (error) return <ErrorBox msg={error} />;
    return <Loading text="正在统计复杂度…" />;
  }

  const q0 = data.quantiles;
  const total = data.total;
  const rows = data.rows;
  const active = mod || bucket || kind || test || q || sort !== 'complexity';

  return (
    <>
      <div className="kpis">
        <Kpi k="函数总数" v={fmtInt(total)} color="var(--accent)" />
        <Kpi k="P50 复杂度" v={q0.p50} color="var(--cx1)" d="一半函数不高于此值" />
        <Kpi k="P90 复杂度" v={q0.p90} color="var(--cx3)" d="长尾起点" />
        <Kpi k="P95 复杂度" v={q0.p95} color="var(--cx4)" />
        <Kpi k="P99 复杂度" v={q0.p99} color="var(--cx5)" />
        <Kpi k="最大复杂度" v={q0.max} color="var(--danger)" d="建议优先重构" />
      </div>

      <Card
        title="函数 × 复杂度 散点图"
        help="横轴 = 代码行数（对数刻度），纵轴 = 圈复杂度；点的直径表示循环嵌套深度；随下方筛选条件联动。"
        right={<Badge tone="info">{fmtInt(data.scatter.length)} 点</Badge>}
      >
        {data.scatter.length ? (
          <ScatterPlot points={data.scatter} onOpen={openSource} />
        ) : (
          <Empty text="当前筛选条件下没有可绘制的函数" />
        )}
      </Card>

      <Card title="复杂度分档直方图" help="点柱子可筛选下方明细；右侧两档占比越低越好。">
        <Histogram
          data={CX_ORDER.map((k) => ({ key: k, label: CX_LABEL[k], value: data.hist[k] ?? 0 }))}
          colors={CX_COLOR}
          onPick={(k) => withReset(() => setBucket(bucket === k ? '' : k))}
        />
        <div className="tiny dim" style={{ marginTop: 8 }}>
          健康信号：右侧两档占比越低越好。当前 ≥21 的函数占{' '}
          {(((data.hist['21-40'] ?? 0) + (data.hist['40+'] ?? 0)) / Math.max(1, total) * 100).toFixed(2)}%。
        </div>
      </Card>

      <Card
        title="复杂度明细"
        hint={`共 ${fmtInt(data.filtered)} 条${loading ? ' · 更新中' : ''}`}
        help={
          <>
            圈复杂度按独立判定路径计，认知复杂度按嵌套与控制流中断加权，两者一起看再决定重构优先级。
            <HelpLink onClick={() => nav('metrics', { query: 'complexity', token: Date.now() })}>复杂度指标口径</HelpLink>
          </>
        }
        bodyClass="tight"
        right={
          <>
            <select value={mod} onChange={(e) => withReset(() => setMod(e.target.value))}>
              <option value="">全部模块</option>
              {modules.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
            <select value={bucket} onChange={(e) => withReset(() => setBucket(e.target.value))}>
              <option value="">全部复杂度档</option>
              {CX_ORDER.map((k) => (
                <option key={k} value={k}>{CX_LABEL[k]}</option>
              ))}
            </select>
            <select value={kind} onChange={(e) => withReset(() => setKind(e.target.value))}>
              <option value="">全部类型</option>
              {KINDS.map((k) => (
                <option key={k.id} value={k.id}>{k.label}</option>
              ))}
            </select>
            <select value={test} onChange={(e) => withReset(() => setTest(e.target.value))}>
              <option value="">含测试代码</option>
              <option value="hide">排除测试代码</option>
              <option value="only">只看测试代码</option>
            </select>
            <select value={sort} onChange={(e) => withReset(() => setSort(e.target.value))}>
              {SORTS.map((s) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
            <input
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') withReset(() => setQ(qInput));
              }}
              placeholder="函数 / 类 / 文件 / 包"
              style={{ width: 168 }}
            />
            <button className="btn sm" onClick={() => withReset(() => setQ(qInput))}>查询</button>
            {active && <button className="btn sm" onClick={reset}>重置</button>}
            <button
              className="btn sm"
              title="按当前筛选条件导出全量结果"
              onClick={() =>
                void exportCsv(project, { module: mod, bucket, kind, test, sort, q }).catch((e: Error) =>
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
          <Empty text={active ? '当前筛选条件下没有命中' : '暂无函数数据'} />
        ) : (
          <>
            <div style={{ maxHeight: 620, overflow: 'auto' }}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th style={{ width: 52 }}>#</th>
                    <th>函数</th>
                    <th>所属类</th>
                    <th>模块</th>
                    <th className="num">复杂度</th>
                    <th className="num">认知</th>
                    <th className="num">行数</th>
                    <th className="num">参数</th>
                    <th className="num">循环深度</th>
                    <th>位置</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((x, i) => (
                    <tr key={x.id}>
                      <td className="num dim">{data.from + i}</td>
                      <td className="mono">
                        {x.name}
                        {x.isEntry && <Badge tone="info">入口</Badge>}
                        {x.isTest && <span className="chip" style={{ marginLeft: 6 }}>测试</span>}
                      </td>
                      <td className="mono dim">{x.cls || '—'}</td>
                      <td className="mono dim tiny">{x.module}</td>
                      <td className="num"><Badge tone={cxTone(x.complexity)}>{x.complexity}</Badge></td>
                      <td className="num dim">{x.cognitive}</td>
                      <td className="num dim">{x.lines}</td>
                      <td className="num dim">{x.paramCount}</td>
                      <td className="num dim">{x.loopDepth}</td>
                      <td>
                        <span
                          className="mono tiny"
                          style={{ color: 'var(--accent)', cursor: 'pointer' }}
                          onClick={() => openSource(x.file, x.line)}
                          title={x.file}
                        >
                          {x.file.split('/').slice(-2).join('/')}:{x.line}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <Pager
              meta={data}
              loading={loading}
              onPage={setPage}
              onPageSize={(n) => setPageSize(n)}
            />
          </>
        )}
      </Card>
    </>
  );
}

/** 按当前筛选条件取全量结果并导出 CSV */
async function exportCsv(
  project: string,
  filter: { module: string; bucket: string; kind: string; test: string; sort: string; q: string }
) {
  const d = await apiGet<ComplexityData>('/complexity', { project, ...filter, all: 1 });
  downloadCsv(
    csvName('复杂度明细', project),
    ['函数', '类型', '所属类', '模块', '包', '文件', '起始行', '结束行', '复杂度', '认知复杂度', '行数', '参数个数', '循环深度', '入口', '测试代码', '签名'],
    d.rows.map((r) => [
      r.name, r.kind, r.cls, r.module, r.pkg, r.file, r.line, r.endLine,
      r.complexity, r.cognitive, r.lines, r.paramCount, r.loopDepth,
      r.isEntry ? '是' : '', r.isTest ? '是' : '', r.signature,
    ])
  );
}
