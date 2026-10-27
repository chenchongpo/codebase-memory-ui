/**
 * 最小 MCP 客户端：支持 **两种传输**，由配置 cbm.transport 选择。
 *
 *   http  —— MCP Streamable HTTP：POST JSON-RPC 到 endpoint。
 *            请求头 Accept 同时声明 application/json 与 text/event-stream；
 *            服务端可直接回 JSON，也可回 SSE 流（逐条解析 data: 事件）；
 *            initialize 若下发 Mcp-Session-Id，后续请求原样带回；鉴权用 Bearer Token。
 *            适合团队共享一台索引机：不用在本机放原生二进制，也不用管守护进程。
 *
 *   stdio —— 拉起本地 codebase-memory-mcp 进程，走换行分隔的 JSON-RPC（stdin/stdout）。
 *            适合单机 / 离网环境，无需额外服务。
 *
 * 两者对外暴露同一组方法（connect / callTool / request / close / ping），
 * 调用方用 createSession(cfg) 取实例，不需要关心底层传输。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_TIMEOUT = 180000;
const WIN = process.platform === 'win32';

/** 把原始报错翻译成能照着做的中文提示 */
export function explain(errcode) {
  const m = String(errcode ?? '');
  if (/ECONNREFUSED|fetch failed|connect ECONN/i.test(m)) {
    return '连不上索引服务：请确认「索引服务端点」地址可访问，且索引服务已启动；若用 stdio 传输，请检查可执行文件路径。';
  }
  if (/401|unauthorized/i.test(m)) return '索引服务拒绝了请求（401）：检查「索引服务 Token」是否正确。';
  if (/404|not found/i.test(m)) return '端点不存在（404）：地址可能少了路径，例如应以 /mcp 结尾。';
  if (/timeout|timed out|aborted/i.test(m)) return '等待索引服务响应超时：仓库较大时可调大「请求超时」，或检查索引服务负载。';
  if (/ENOENT|not found:/i.test(m)) return '找不到 codebase-memory-mcp 可执行文件：请在配置里填写完整路径。';
  return m;
}

/* ------------------------------------------------------------------ 工具 */

/** 极简 SSE 解析：把 text/event-stream 响应切成 {event, data} 事件 */
async function* readSse(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = 'message';
      const data = [];
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trim());
      }
      if (data.length) yield { event, data: data.join('\n') };
    }
  }
}

/** progress / 其它服务端通知统一落到任务日志 */
function logNotification(msg, onLog) {
  if (msg?.method === 'notifications/progress') {
    const d = msg.params ?? {};
    const pct =
      typeof d.progress === 'number' && typeof d.total === 'number' && d.total > 0
        ? ` ${Math.round((d.progress / d.total) * 100)}%`
        : '';
    onLog('progress', `${d.message ?? '处理中'}${pct}`);
  } else if (msg?.method) {
    onLog('mcp', `${msg.method}`);
  }
}

/* --------------------------------------------------------- HTTP 传输 */

export class HttpMcpSession {
  constructor({ endpoint, token = '', timeoutMs = DEFAULT_TIMEOUT, onLog = () => {} }) {
    this.endpoint = endpoint;
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.onLog = onLog;
    this.sessionId = '';
    this.nextId = 1;
    this.closed = false;
  }

  headers() {
    const h = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2024-11-05',
    };
    if (this.token) h.authorization = `Bearer ${this.token}`;
    if (this.sessionId) h['mcp-session-id'] = this.sessionId;
    return h;
  }

  async request(method, params, timeoutMs = this.timeoutMs) {
    if (this.closed) throw new Error('MCP 会话已关闭');
    if (!this.endpoint) throw new Error('未配置索引服务端点');
    const id = this.nextId++;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: ac.signal,
      });
      const sid = res.headers.get('mcp-session-id');
      if (sid) this.sessionId = sid;

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(explain(`HTTP ${res.status} ${text.slice(0, 200)}`));
      }

      const ctype = res.headers.get('content-type') ?? '';
      if (ctype.includes('text/event-stream')) {
        for await (const ev of readSse(res)) {
          let msg;
          try {
            msg = JSON.parse(ev.data);
          } catch {
            continue;
          }
          if (msg.id === id) {
            if (msg.error) throw new Error(explain(msg.error.message ?? JSON.stringify(msg.error)));
            return msg.result;
          }
          logNotification(msg, this.onLog);
        }
        throw new Error(explain('SSE 流已结束但没有收到响应'));
      }

      const json = await res.json();
      if (json.error) throw new Error(explain(json.error.message ?? JSON.stringify(json.error)));
      return json.result;
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new Error(explain(`等待 ${method} 超时（${Math.round(timeoutMs / 1000)}s）`));
      }
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      clearTimeout(timer);
    }
  }

  /** 通知没有 id，服务端通常直接 202；失败不影响主流程 */
  async notify(method, params = {}) {
    try {
      await fetch(this.endpoint, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ jsonrpc: '2.0', method, params }),
      });
    } catch {
      /* 通知失败可忽略 */
    }
  }

  async connect() {
    const res = await this.request(
      'initialize',
      { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'codebase-insight', version: '0.4.0' } },
      Math.min(this.timeoutMs, 60000)
    );
    await this.notify('notifications/initialized');
    return res ?? {};
  }

  async callTool(name, args = {}, timeoutMs = this.timeoutMs) {
    const res = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    return unwrapToolResult(name, res);
  }

  async ping() {
    const info = await this.connect();
    return { serverInfo: info, tools: await this.safeTools() };
  }

  async safeTools() {
    try {
      return ((await this.request('tools/list', {}, 15000))?.tools ?? []).map((t) => t.name);
    } catch {
      return [];
    }
  }

  close() {
    this.closed = true;
  }
}

/* -------------------------------------------------------- stdio 传输 */

/** 常见安装位置（按优先级），首个存在的即默认值 */
function exeCandidates(configured) {
  const out = [];
  if (configured) out.push(configured);
  const rel = `node_modules/codebase-memory-mcp/bin/${WIN ? 'codebase-memory-mcp.exe' : 'codebase-memory-mcp'}`;
  if (process.env.APPDATA) out.push(path.join(process.env.APPDATA, 'npm', rel));
  const home = os.homedir();
  out.push(path.join(home, 'AppData', 'Roaming', 'npm', rel));
  out.push(path.join(home, '.local', 'share', 'npm', rel));
  out.push('/usr/local/bin/codebase-memory-mcp');
  out.push('/opt/homebrew/bin/codebase-memory-mcp');
  return out;
}

export function resolveExe(configured = '') {
  const want = String(configured ?? '').trim();
  if (want) return { path: want, exists: fs.existsSync(want), source: 'config' };
  for (const c of exeCandidates('')) {
    if (c && fs.existsSync(c)) return { path: c, exists: true, source: 'auto' };
  }
  const first = exeCandidates('')[0] ?? 'codebase-memory-mcp';
  return { path: first, exists: false, source: 'not-found' };
}

export class StdioMcpSession {
  constructor({ exe, env = {}, timeoutMs = DEFAULT_TIMEOUT, onLog = () => {} }) {
    this.exe = exe;
    this.env = env;
    this.timeoutMs = timeoutMs;
    this.onLog = onLog;
    this.child = null;
    this.buf = '';
    this.nextId = 1;
    this.pending = new Map();
    this.stderrTail = [];
    this.closed = false;
  }

  connect(timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, v) => {
        if (settled) return;
        settled = true;
        fn(v);
      };
      try {
        this.child = spawn(this.exe, [], {
          env: { ...process.env, ...this.env },
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (err) {
        reject(new Error(`无法启动 ${this.exe}：${err.message}`));
        return;
      }

      const timer = setTimeout(() => {
        const tail = this.stderrTail.slice(-3).join(' · ');
        done(reject, new Error(explain(tail || `启动超时（${Math.round(timeoutMs / 1000)}s 未完成握手）`)));
        this.close();
      }, timeoutMs);

      this.child.stdout.setEncoding('utf8');
      this.child.stdout.on('data', (c) => this._onData(c));
      this.child.stderr.setEncoding('utf8');
      this.child.stderr.on('data', (chunk) => {
        const text = String(chunk).trim();
        if (!text) return;
        for (const line of text.split(/\r?\n/)) {
          if (!line.trim()) continue;
          this.stderrTail.push(line.trim());
          if (this.stderrTail.length > 20) this.stderrTail.shift();
          this.onLog('mcp', line.trim());
        }
      });
      this.child.on('error', (err) => {
        clearTimeout(timer);
        done(reject, new Error(explain(`进程错误：${err.message}`)));
      });
      this.child.on('exit', (code) => {
        clearTimeout(timer);
        this.closed = true;
        for (const [, p] of this.pending) p.reject(new Error(`MCP 进程已退出（code ${code}）`));
        this.pending.clear();
        if (!settled) {
          const tail = this.stderrTail.slice(-3).join(' · ');
          done(reject, new Error(explain(tail || `MCP 进程启动后立即退出（code ${code}）`)));
        }
      });

      this.request(
        'initialize',
        { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'codebase-insight', version: '0.4.0' } },
        timeoutMs
      )
        .then((res) => {
          clearTimeout(timer);
          this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          done(resolve, res?.serverInfo ?? {});
        })
        .catch((err) => {
          clearTimeout(timer);
          done(reject, err);
        });
    });
  }

  _onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.onLog('mcp', line.slice(0, 300));
        continue;
      }
      if (msg.id !== undefined && msg.id !== null && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(explain(msg.error.message ?? JSON.stringify(msg.error))));
        else p.resolve(msg.result);
        continue;
      }
      logNotification(msg, this.onLog);
    }
  }

  send(obj) {
    if (!this.child || this.closed) throw new Error('MCP 会话未连接');
    this.child.stdin.write(`${JSON.stringify(obj)}\n`);
  }

  request(method, params, timeoutMs = 0) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let timer = null;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(explain(`等待 ${method} 超时（${Math.round(timeoutMs / 1000)}s）`)));
        }, timeoutMs);
      }
      this.pending.set(id, {
        resolve: (v) => {
          if (timer) clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          if (timer) clearTimeout(timer);
          reject(e);
        },
      });
      try {
        this.send({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  async callTool(name, args = {}, timeoutMs = 0) {
    const res = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    return unwrapToolResult(name, res);
  }

  async ping() {
    const info = await this.connect();
    let tools = [];
    try {
      tools = ((await this.request('tools/list', {}, 15000))?.tools ?? []).map((t) => t.name);
    } catch {
      /* 不影响握手结果 */
    }
    return { serverInfo: info, tools };
  }

  close() {
    this.closed = true;
    if (!this.child) return;
    try {
      this.child.stdin.end();
    } catch {
      /* ignore */
    }
    try {
      this.child.kill();
    } catch {
      /* ignore */
    }
    this.child = null;
  }
}

/* ------------------------------------------------------------- 公共 */

/** 统一解包 tools/call 结果 */
function unwrapToolResult(name, res) {
  if (res?.isError) {
    const text = (res.content ?? []).map((c) => c?.text ?? '').join('\n').trim();
    const err = new Error(explain(text || `${name} 执行失败`));
    err.toolResult = res;
    throw err;
  }
  if (res?.structuredContent) return res.structuredContent;
  const text = (res?.content ?? []).map((c) => c?.text ?? '').join('\n').trim();
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

/** stdio 传输的环境变量：缓存目录 / 运行目录决定索引落库位置，必须与读取端一致 */
function envFor(cfg, cacheDir) {
  const env = {};
  const cache = cacheDir || cfg.cbm.cacheDir;
  if (cache) env.CBM_CACHE_DIR = cache;
  if (cfg.cbm.runtimeDir) env.CBM_RUNTIME_DIR = cfg.cbm.runtimeDir;
  return env;
}

/**
 * 按配置创建会话。
 *
 * @param cfg       effective() 的结果（需要 cfg.cbm）
 * @param opts.onLog 日志回调
 * @param opts.cacheDir 已解析出的图库目录（优先于配置）
 */
export function createSession(cfg, { onLog = () => {}, cacheDir = '' } = {}) {
  const cbm = cfg.cbm;
  if (cbm.transport === 'stdio') {
    const exe = resolveExe(cbm.exePath);
    return new StdioMcpSession({
      exe: exe.path,
      env: envFor(cfg, cacheDir),
      timeoutMs: cbm.timeoutMs,
      onLog,
    });
  }
  return new HttpMcpSession({ endpoint: cbm.endpoint, token: cbm.token, timeoutMs: cbm.timeoutMs, onLog });
}

/** 一次性探测（配置页「检测索引服务」用），两种传输都支持 */
export async function probeService(cfg, { cacheDir = '' } = {}) {
  const cbm = cfg.cbm;
  if (cbm.transport === 'stdio') {
    const exe = resolveExe(cbm.exePath);
    if (!exe.exists) {
      return { ok: false, transport: 'stdio', exe: exe.path, error: `找不到可执行文件：${exe.path}` };
    }
    const s = new StdioMcpSession({ exe: exe.path, env: envFor(cfg, cacheDir), timeoutMs: 30000 });
    try {
      const r = await s.ping();
      return { ok: true, transport: 'stdio', exe: exe.path, name: r.serverInfo?.name ?? '', version: r.serverInfo?.version ?? '', tools: r.tools };
    } catch (err) {
      return { ok: false, transport: 'stdio', exe: exe.path, error: explain(err?.message ?? err) };
    } finally {
      s.close();
    }
  }

  if (!cbm.endpoint) return { ok: false, transport: 'http', error: '未配置索引服务端点' };
  const s = new HttpMcpSession({ endpoint: cbm.endpoint, token: cbm.token, timeoutMs: 15000 });
  try {
    const r = await s.ping();
    return { ok: true, transport: 'http', endpoint: cbm.endpoint, name: r.serverInfo?.name ?? '', version: r.serverInfo?.version ?? '', tools: r.tools };
  } catch (err) {
    return { ok: false, transport: 'http', endpoint: cbm.endpoint, error: explain(err?.message ?? err) };
  } finally {
    s.close();
  }
}
