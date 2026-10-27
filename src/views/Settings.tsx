import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { apiGet, apiPost, fmtBytes, fmtInt, useApi } from '../api';
import type { AppConfig, IndexConfig, IndexStatus, McpStatus, ProbeResult, ProjectInfo } from '../types';
import { Badge, Card, ErrorBox, Help, Loading } from '../components/ui';
import { DirPicker } from '../components/DirPicker';
import type { ViewProps } from '../lib/nav';

type Draft = {
  cbm: AppConfig['cbm'];
  analysis: AppConfig['analysis'];
  index: IndexConfig;
};

const MASK = '••••••••';

const MODES: { id: IndexConfig['mode']; label: string; hint: string }[] = [
  { id: 'full', label: '完整', hint: '全部文件 + 语义（类型/调用解析最全，最慢）' },
  { id: 'moderate', label: '适中', hint: '过滤后再做语义（推荐，多数项目够用）' },
  { id: 'fast', label: '快速', hint: '只做结构解析，不建语义边（最快）' },
];

const STATE_LABEL: Record<IndexStatus['state'], string> = {
  idle: '未开始',
  running: '索引中',
  done: '已完成',
  failed: '失败',
  canceled: '已取消',
};

function toDraft(c: AppConfig): Draft {
  return {
    cbm: { ...c.cbm, token: '' },
    analysis: {
      excludeDirs: [...c.analysis.excludeDirs],
      testPatterns: [...c.analysis.testPatterns],
      deadcodeExclude: [...(c.analysis.deadcodeExclude ?? [])],
    },
    index: {
      repoPath: c.index?.repoPath ?? '',
      mode: c.index?.mode ?? 'full',
      name: c.index?.name ?? '',
      lastProject: c.index?.lastProject ?? '',
    },
  };
}

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="cfg-field">
      <div className="cfg-label">
        <span>{label}</span>
        {hint && <Help>{hint}</Help>}
      </div>
      {children}
    </div>
  );
}

export default function Settings({ refresh, selectProject, nav }: ViewProps) {
  const { data, loading, error, reload } = useApi<AppConfig>('/config');
  const projectsApi = useApi<{ cacheDir: string | null; projects: ProjectInfo[] }>('/projects');

  const [draft, setDraft] = useState<Draft | null>(null);
  const [tokenInput, setTokenInput] = useState('');
  const [clearToken, setClearToken] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState('');
  const [saveErr, setSaveErr] = useState('');
  const [probe, setProbe] = useState<Record<string, ProbeResult | { error: string } | null>>({});

  /* 索引任务 */
  const [pickerOpen, setPickerOpen] = useState(false);
  const [idx, setIdx] = useState<IndexStatus | null>(null);
  const [polling, setPolling] = useState(false);
  const [startErr, setStartErr] = useState('');
  const [svc, setSvc] = useState<McpStatus | null>(null);
  const [svcLoading, setSvcLoading] = useState(false);
  const logRef = useRef<HTMLDivElement | null>(null);

  /** 轮询索引任务：running 时每 1.2s 拉一次，结束即停 */
  useEffect(() => {
    let stop = false;
    let timer = 0;
    const tick = async () => {
      try {
        const s = await apiGet<IndexStatus>('/index/status');
        if (stop) return;
        setIdx(s);
        if (s.state === 'running') timer = window.setTimeout(tick, 1200);
        else {
          setPolling(false);
          if (s.state === 'done') refresh?.();
        }
      } catch {
        if (!stop) timer = window.setTimeout(tick, 2500);
      }
    };
    void tick();
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polling]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [idx?.logTotal]);

  useEffect(() => {
    if (!data) return;
    setDraft(toDraft(data));
    setTokenInput('');
    setClearToken(false);
    setDirty(false);
  }, [data]);

  const defaults = data?.meta.defaults;

  const patch = (fn: (d: Draft) => Draft) => {
    setDraft((d) => (d ? fn(d) : d));
    setDirty(true);
    setSavedAt('');
    setSaveErr('');
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setSaveErr('');
    try {
      const token = clearToken ? '' : tokenInput.trim() ? tokenInput.trim() : MASK;
      const next = await apiPost<AppConfig>('/config', {
        cbm: { ...draft.cbm, token },
        analysis: draft.analysis,
        index: draft.index,
      });
      setSavedAt(next.savedAt ?? new Date().toISOString());
      setDirty(false);
      setTokenInput('');
      setClearToken(false);
      reload();
      refresh?.();
    } catch (e) {
      setSaveErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const restoreDefaults = () => {
    if (!defaults) return;
    if (!window.confirm('把本页草稿恢复为出厂默认值？需要点「保存配置」才会写盘。')) return;
    setDraft({
      cbm: { ...defaults.cbm },
      analysis: {
        excludeDirs: [...defaults.analysis.excludeDirs],
        testPatterns: [...defaults.analysis.testPatterns],
        deadcodeExclude: [...(defaults.analysis.deadcodeExclude ?? [])],
      },
      index: {
        repoPath: defaults.index.repoPath,
        mode: defaults.index.mode,
        name: defaults.index.name,
        lastProject: '',
      },
    });
    setDirty(true);
    setSavedAt('');
  };

  /** 探测走 GET（只读），结果按「kind:path」缓存 */
  const probeViaGet = async (kind: 'dir' | 'file', target: string) => {
    const key = `${kind}:${target}`;
    setProbe((p) => ({ ...p, [key]: null }));
    try {
      const qs = new URLSearchParams({ path: target, kind });
      const res = await fetch(`/api/config/probe?${qs}`);
      const json = (await res.json()) as ProbeResult & { error?: string };
      setProbe((p) => ({ ...p, [key]: res.ok ? json : { error: json.error ?? `HTTP ${res.status}` } }));
    } catch (e) {
      setProbe((p) => ({ ...p, [key]: { error: (e as Error).message } }));
    }
  };

  const startIndex = async () => {
    if (!draft) return;
    setStartErr('');
    try {
      const s = await apiPost<IndexStatus>('/index/run', {
        repoPath: draft.index.repoPath,
        mode: draft.index.mode,
        name: draft.index.name,
      });
      setIdx(s);
      setPolling(true);
      setDirty(false);
      setSavedAt(new Date().toISOString());
    } catch (e) {
      setStartErr((e as Error).message);
    }
  };

  const cancelIndex = async () => {
    try {
      await apiPost('/index/cancel', {});
      setPolling(true);
    } catch (e) {
      setStartErr((e as Error).message);
    }
  };

  /** 探测索引服务（http / stdio 都走这一个接口） */
  const probeService = async () => {
    setSvcLoading(true);
    try {
      setSvc(await apiGet<McpStatus>('/mcp/status'));
    } catch (e) {
      setStartErr((e as Error).message);
    } finally {
      setSvcLoading(false);
    }
  };

  const tokenState = useMemo(() => {
    if (!data) return { label: '', tone: 'mute' as const };
    if (data.meta.tokenFromEnv) return { label: '来自环境变量', tone: 'info' as const };
    if (data.cbm.tokenSet) return { label: '已保存', tone: 'ok' as const };
    return { label: '未配置', tone: 'mute' as const };
  }, [data]);

  if (error) return <ErrorBox msg={error} />;
  if (loading || !data || !draft) return <Loading text="正在读取本地配置…" />;

  const cacheProbe = probe[`dir:${draft.cbm.cacheDir}`];
  const exeProbe = probe[`file:${draft.cbm.exePath}`];
  const idxState = idx?.state ?? 'idle';
  const idxTone: 'ok' | 'info' | 'warn' | 'danger' | 'mute' =
    idxState === 'done' ? 'ok' : idxState === 'failed' ? 'danger' : idxState === 'running' ? 'info' : idxState === 'canceled' ? 'warn' : 'mute';
  const running = idxState === 'running';
  const res = idx?.result ?? null;
  const isHttp = draft.cbm.transport === 'http';

  return (
    <>
      <div className="notice" style={{ marginBottom: 14, display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
        <span>
          配置文件 <code>{data.meta.configPath}</code>
          {data.meta.exists ? <Badge tone="ok">已存在</Badge> : <Badge tone="warn">首次保存时创建</Badge>}
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--fg-faint)' }}>
          保存后立即生效
          <Help>保存后图数据库连接会按新目录自动重连，无需重启服务；分析口径在刷新「无引用代码」页面后生效。</Help>
        </span>
        {savedAt && <span className="cfg-saved">● 已保存 {savedAt.slice(11, 19)}</span>}
        {dirty && <Badge tone="warn">有未保存修改</Badge>}
      </div>

      <Card
        title="代码索引"
        help="选一个代码文件夹，由本服务通过 MCP 调用索引器的 index_repository 解析；图库落盘后即可在本站浏览。传输方式在下方「索引服务」里选择：http 走远端索引机，stdio 拉起本机进程。"
        right={<Badge tone={idxTone}>{STATE_LABEL[idxState]}</Badge>}
      >
        <div className="cfg-grid">
          <div style={{ gridColumn: '1 / -1' }}>
            <Field label="代码库根路径" hint="要索引的源码目录（不是图数据库目录）。解析结果落到「图数据库目录」里。">
              <div className="cfg-inline">
                <input
                  type="text"
                  value={draft.index.repoPath}
                  spellCheck={false}
                  placeholder="例如 D:/0.project/3.java/RuoYi"
                  onChange={(e) => patch((d) => ({ ...d, index: { ...d.index, repoPath: e.target.value } }))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !running) void startIndex();
                  }}
                />
                <button className="btn sm" onClick={() => setPickerOpen(true)}>浏览…</button>
                <button className="btn primary sm" disabled={running || !draft.index.repoPath.trim()} onClick={() => void startIndex()}>
                  {running ? '索引中…' : '开始索引'}
                </button>
              </div>
            </Field>
          </div>

          <Field label="索引模式" hint={MODES.find((m) => m.id === draft.index.mode)?.hint}>
            <div className="seg">
              {MODES.map((m) => (
                <button
                  key={m.id}
                  className={draft.index.mode === m.id ? 'on' : ''}
                  title={m.hint}
                  onClick={() => patch((d) => ({ ...d, index: { ...d.index, mode: m.id } }))}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </Field>

          <Field label="项目名（可选）" hint="留空由索引器按路径自动生成；填了就用这里覆盖。">
            <input
              type="text"
              value={draft.index.name}
              placeholder="自动生成"
              onChange={(e) => patch((d) => ({ ...d, index: { ...d.index, name: e.target.value } }))}
            />
          </Field>
        </div>

        <div className="idx-badge-row">
          <Badge tone={idxTone}>{STATE_LABEL[idxState]}</Badge>
          {idx?.stage && idxState === 'running' && <span className="tiny dim">阶段：{idx.stage}</span>}
          {!!idx?.elapsedMs && <span className="tiny dim">用时 {(idx.elapsedMs / 1000).toFixed(1)}s</span>}
          {idx?.project && <span className="tiny mono dim">{idx.project}</span>}
          <span className="grow" />
          {running && <button className="btn sm" onClick={() => void cancelIndex()}>取消</button>}
        </div>

        {startErr && <div className="notice danger" style={{ marginTop: 10 }}>{startErr}</div>}

        {idxState === 'failed' && idx?.error && (
          <div className="notice danger" style={{ marginTop: 10 }}>
            <b>索引失败</b>：{idx.error}
          </div>
        )}

        {idxState === 'done' && res && (
          <div className="notice ok" style={{ marginTop: 10, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <span>
              <b>索引完成</b> · {res.project} · {fmtInt(res.nodes)} 节点 / {fmtInt(res.edges)} 边 · 解析耗时{' '}
              {(res.parseMs / 1000).toFixed(1)}s · 库大小 {fmtBytes(res.dbBytes)}
              <div className="mono tiny" style={{ color: 'var(--fg-faint)', marginTop: 3 }}>{res.dbPath || res.rootPath}</div>
            </span>
            <span className="grow" />
            <button
              className="btn sm"
              onClick={() => {
                selectProject?.(res.project);
                nav('overview');
              }}
            >
              打开该项目
            </button>
          </div>
        )}

        <div className="idx-console" ref={logRef}>
          {!idx?.log?.length ? (
            <div className="idx-empty">索引日志会显示在这里：连接索引服务 → 解析代码 → 回读图库。</div>
          ) : (
            idx.log.map((l, i) => (
              <div key={`${l.t}-${i}`} className={`idx-line ${l.level}`}>
                <span className="t">{l.t.slice(11, 19)}</span>
                <span className="x">{l.text}</span>
              </div>
            ))
          )}
        </div>
      </Card>

      <DirPicker
        open={pickerOpen}
        initial={draft.index.repoPath}
        onClose={() => setPickerOpen(false)}
        onPick={(p) => {
          patch((d) => ({ ...d, index: { ...d.index, repoPath: p } }));
          setPickerOpen(false);
        }}
      />

      <Card
        title="索引服务"
        help="MCP 客户端支持两种传输：http（Streamable HTTP，适合团队共享一台索引机）与 stdio（拉起本地 codebase-memory-mcp 进程，适合单机/离网）。切换后点「检测」验证连通性。"
        right={<Badge tone={tokenState.tone}>{tokenState.label}</Badge>}
      >
        <div className="cfg-grid">
          <Field label="传输方式" hint="http：POST JSON-RPC 到端点；stdio：启动本地可执行文件，走标准输入输出。">
            <div className="seg">
              <button className={isHttp ? 'on' : ''} onClick={() => patch((d) => ({ ...d, cbm: { ...d.cbm, transport: 'http' } }))}>
                HTTP
              </button>
              <button className={!isHttp ? 'on' : ''} onClick={() => patch((d) => ({ ...d, cbm: { ...d.cbm, transport: 'stdio' } }))}>
                stdio
              </button>
            </div>
          </Field>

          <Field label="请求超时（秒）" hint="索引大仓库较慢，超时过小会把正常任务判为失败。">
            <input
              type="number"
              min={5}
              max={3600}
              value={Math.round(draft.cbm.timeoutMs / 1000)}
              onChange={(e) => patch((d) => ({ ...d, cbm: { ...d.cbm, timeoutMs: Math.max(5, Number(e.target.value) || 180) * 1000 } }))}
            />
          </Field>

          {isHttp ? (
            <>
              <Field
                label="服务端点"
                hint={
                  <>
                    MCP Streamable HTTP 地址，通常以 <code>/mcp</code> 结尾。
                    {data.meta.endpointFromEnv && ' 当前由环境变量 CBM_ENDPOINT 覆盖。'}
                  </>
                }
              >
                <div className="cfg-inline">
                  <input
                    type="text"
                    value={draft.cbm.endpoint}
                    spellCheck={false}
                    placeholder="http://127.0.0.1:7801/mcp"
                    onChange={(e) => patch((d) => ({ ...d, cbm: { ...d.cbm, endpoint: e.target.value } }))}
                  />
                  <button className="btn sm" disabled={svcLoading} onClick={() => void probeService()}>
                    {svcLoading ? '检测中…' : '检测'}
                  </button>
                </div>
              </Field>

              <Field
                label="访问 Token（可选）"
                hint={
                  <>
                    以 <code>Authorization: Bearer</code> 发送。保存后只显示掩码。
                    {data.meta.tokenFromEnv && ' 当前由环境变量 CBM_TOKEN 覆盖。'}
                  </>
                }
              >
                <div className="cfg-inline">
                  <input
                    type="password"
                    value={tokenInput}
                    placeholder={clearToken ? '（待清除）' : data.cbm.tokenSet ? MASK : '可留空'}
                    onChange={(e) => {
                      setTokenInput(e.target.value);
                      setClearToken(false);
                      setDirty(true);
                    }}
                  />
                  {data.cbm.tokenSet && !clearToken && (
                    <button
                      className="btn sm"
                      onClick={() => {
                        setClearToken(true);
                        setTokenInput('');
                        setDirty(true);
                      }}
                    >
                      清除
                    </button>
                  )}
                  {clearToken && (
                    <button className="btn sm" onClick={() => setClearToken(false)}>
                      撤销
                    </button>
                  )}
                </div>
              </Field>
            </>
          ) : (
            <>
              <Field
                label="可执行文件"
                hint={
                  <>
                    codebase-memory-mcp 的完整路径（填 <b>.exe</b>，不是 .cmd 包装脚本）。留空自动探测 npm 全局安装位置，
                    也可用环境变量 <code>CBM_EXE</code> 指定。
                  </>
                }
              >
                <div className="cfg-inline">
                  <input
                    type="text"
                    value={draft.cbm.exePath}
                    spellCheck={false}
                    placeholder="留空自动探测"
                    onChange={(e) => patch((d) => ({ ...d, cbm: { ...d.cbm, exePath: e.target.value } }))}
                  />
                  <button className="btn sm" disabled={!draft.cbm.exePath} onClick={() => void probeViaGet('file', draft.cbm.exePath)}>
                    检测
                  </button>
                  <button className="btn sm" disabled={svcLoading} onClick={() => void probeService()}>
                    {svcLoading ? '检测中…' : '连通性'}
                  </button>
                </div>
                {exeProbe && 'error' in exeProbe && exeProbe.error && (
                  <div className="notice danger" style={{ marginTop: 4 }}>{exeProbe.error}</div>
                )}
                {exeProbe && 'exists' in exeProbe && exeProbe.exists && !exeProbe.error && (
                  <div className="notice ok" style={{ marginTop: 4 }}>文件存在</div>
                )}
              </Field>

              <Field label="运行目录（可选）" hint="守护进程的管道 / 锁文件放在这里；留空用环境变量 CBM_RUNTIME_DIR 或工具默认值。">
                <input
                  type="text"
                  value={draft.cbm.runtimeDir}
                  spellCheck={false}
                  placeholder="留空使用默认"
                  onChange={(e) => patch((d) => ({ ...d, cbm: { ...d.cbm, runtimeDir: e.target.value } }))}
                />
              </Field>
            </>
          )}
        </div>

        {svc && (
          <div className={`notice ${svc.probe?.ok ? 'ok' : 'danger'}`} style={{ marginTop: 10 }}>
            {svc.probe?.ok ? (
              <>
                <b>连通正常</b> · 传输 {svc.probe.transport}
                {svc.probe.version ? ` · 版本 ${svc.probe.version}` : ''}
                {svc.probe.tools?.length ? ` · 工具 ${svc.probe.tools.length} 个` : ''}
                <div className="mono tiny" style={{ marginTop: 3, color: 'var(--fg-faint)' }}>
                  {svc.probe.transport === 'http' ? svc.probe.endpoint : svc.probe.exe}
                </div>
              </>
            ) : (
              <>
                <b>连通失败</b>：{svc.probe?.error ?? '未知错误'}
              </>
            )}
          </div>
        )}
      </Card>

      <Card
        title="数据源"
        right={
          <>
            <button className="btn sm" onClick={restoreDefaults}>恢复默认</button>
            <button className="btn primary sm" disabled={saving} onClick={() => void save()}>
              {saving ? '保存中…' : '保存配置'}
            </button>
          </>
        }
      >
        <div className="cfg-grid">
          <Field
            label="图数据库目录（*.db 所在目录）"
            hint={
              <>
                优先级：本配置 &gt; 环境变量 <code>CBM_CACHE_DIR</code> &gt; 常见默认目录。
                {data.meta.cacheDirFromEnv && ' 当前环境变量已设置，将覆盖此处填写值。'}
              </>
            }
          >
            <div className="cfg-inline">
              <input
                type="text"
                value={draft.cbm.cacheDir}
                placeholder="例如 D:/cbm-cache"
                onChange={(e) => patch((d) => ({ ...d, cbm: { ...d.cbm, cacheDir: e.target.value } }))}
              />
              <button className="btn sm" onClick={() => void probeViaGet('dir', draft.cbm.cacheDir)} disabled={!draft.cbm.cacheDir}>
                检测
              </button>
            </div>
            {cacheProbe && 'error' in cacheProbe && cacheProbe.error && (
              <div className="notice danger" style={{ marginTop: 4 }}>{cacheProbe.error}</div>
            )}
            {cacheProbe && !('error' in cacheProbe && cacheProbe.error) && 'dbCount' in cacheProbe && (
              <div className="notice ok" style={{ marginTop: 4 }}>
                目录可访问，找到 {cacheProbe.dbCount} 个图数据库
                {cacheProbe.databases?.length
                  ? `：${cacheProbe.databases.slice(0, 3).map((d) => d.file).join('、')}${cacheProbe.dbCount > 3 ? ' …' : ''}`
                  : ''}
                <div style={{ color: 'var(--fg-faint)', marginTop: 3 }}>
                  合计 {fmtBytes(cacheProbe.databases?.reduce((a, d) => a + d.bytes, 0) ?? 0)}
                </div>
              </div>
            )}
          </Field>

          <Field
            label="源码根路径映射"
            hint="图库里记录的 root_path 失效时（例如库从别的机器拷来），用本机目录替代，供源码片段读取使用。留空表示直接用库内路径。"
          >
            <div className="cfg-inline">
              <input
                type="text"
                value={draft.cbm.sourceRoot}
                placeholder="例如 D:/0.project/3.java/RuoYi"
                onChange={(e) => patch((d) => ({ ...d, cbm: { ...d.cbm, sourceRoot: e.target.value } }))}
              />
              <button className="btn sm" onClick={() => void probeViaGet('dir', draft.cbm.sourceRoot)} disabled={!draft.cbm.sourceRoot}>
                检测
              </button>
            </div>
            {probe[`dir:${draft.cbm.sourceRoot}`] && (probe[`dir:${draft.cbm.sourceRoot}`] as ProbeResult)?.error && (
              <div className="notice warn" style={{ marginTop: 4 }}>
                {(probe[`dir:${draft.cbm.sourceRoot}`] as ProbeResult).error}
              </div>
            )}
          </Field>

          <Field label="默认项目" hint="未在 URL 上指定 project 参数时打开该项目；留空则取节点数最多的项目。">
            <select
              value={draft.cbm.defaultProject}
              onChange={(e) => patch((d) => ({ ...d, cbm: { ...d.cbm, defaultProject: e.target.value } }))}
            >
              <option value="">自动（节点最多）</option>
              {(projectsApi.data?.projects ?? []).map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name.split('.').slice(-2).join('.')} · {p.nodes} 节点
                </option>
              ))}
              {draft.cbm.defaultProject &&
                !(projectsApi.data?.projects ?? []).some((p) => p.name === draft.cbm.defaultProject) && (
                  <option value={draft.cbm.defaultProject}>{draft.cbm.defaultProject}（当前库中不存在）</option>
                )}
            </select>
            <div className="cfg-hint">当前图库目录下共 {projectsApi.data?.projects.length ?? 0} 个项目。</div>
          </Field>
        </div>
      </Card>

      <Card title="分析口径" help="仅影响「无引用代码」报表的扫描范围与统计口径；修改并保存后刷新该页面生效。">
        <div className="cfg-grid c2">
          <Field
            label="追加排除目录（每行一个目录名）"
            hint="内置已排除 node_modules / target / dist / build / out / vendor / .git，这里只补充项目特有目录，例如 generated、third_party。"
          >
            <textarea
              className="cfg-area"
              value={draft.analysis.excludeDirs.join('\n')}
              placeholder={'generated\nthird_party'}
              onChange={(e) => patch((d) => ({ ...d, analysis: { ...d.analysis, excludeDirs: e.target.value.split('\n') } }))}
            />
          </Field>

          <Field label="测试代码路径正则（每行一条）" hint="命中即视为测试代码，不计入无引用报表。留空用内置规则（tests/、test_*.py、Test*.java 等）。">
            <textarea
              className="cfg-area"
              value={draft.analysis.testPatterns.join('\n')}
              placeholder={'(^|/)src/test/\n_test\\.(go|rs)$'}
              onChange={(e) => patch((d) => ({ ...d, analysis: { ...d.analysis, testPatterns: e.target.value.split('\n') } }))}
            />
          </Field>

          <div style={{ gridColumn: '1 / -1' }}>
            <Field
              label="无引用排查排除规则（每行一条正则）"
              hint="匹配类名 / 全限定名 / 文件路径 / 注解（写 @Scheduled 这样即可）。命中即整条从无引用报表里排除，适合放框架约定与误报。"
            >
              <textarea
                className="cfg-area"
                value={draft.analysis.deadcodeExclude.join('\n')}
                placeholder={'^App$\n@Scheduled\n\\.generated\\.'}
                onChange={(e) => patch((d) => ({ ...d, analysis: { ...d.analysis, deadcodeExclude: e.target.value.split('\n') } }))}
              />
              {data.meta.invalidPatterns.length > 0 && (
                <div className="notice warn" style={{ marginTop: 6 }}>
                  以下正则无法编译，已忽略：
                  {data.meta.invalidPatterns.map((p) => ` ${p.field}:${p.pattern}`).join('；')}
                </div>
              )}
            </Field>
          </div>
        </div>
      </Card>

      {saveErr && <div className="notice danger" style={{ marginBottom: 14 }}>保存失败：{saveErr}</div>}
    </>
  );
}
