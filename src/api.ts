import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectInfo } from './types';

export const API = '/api';

export type Params = Record<string, string | number | undefined | null>;

export function qs(params: Params | null | undefined): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v === undefined || v === null || v === '') continue;
    u.set(k, String(v));
  }
  const s = u.toString();
  return s ? `?${s}` : '';
}

export async function apiGet<T>(path: string, params: Params | null = {}): Promise<T> {
  const res = await fetch(`${API}${path}${qs(params)}`);
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = JSON.parse(await res.text());
      if (j?.error) msg = j.error;
    } catch {
      /* 保持原始状态码 */
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 交给下面的错误分支 */
  }
  if (!res.ok) {
    const msg = (json as { error?: string } | null)?.error ?? (text ? text.slice(0, 200) : `HTTP ${res.status}`);
    throw new Error(msg);
  }
  return json as T;
}

interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * 轻量数据钩子：path 为 null 时不请求。
 * 请求序号守卫避免慢响应覆盖新响应。
 */
export function useApi<T>(path: string | null, params: Params | null = {}, deps: unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(!!path);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const key = `${path}${qs(params)}`;
  const keyRef = useRef(key);
  keyRef.current = key;

  const run = useCallback(() => {
    if (!path) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }
    const id = ++seq.current;
    setLoading(true);
    setError(null);
    apiGet<T>(path, params)
      .then((d) => {
        if (id === seq.current) {
          setData(d);
          setLoading(false);
        }
      })
      .catch((e: Error) => {
        if (id === seq.current) {
          setError(e.message);
          setLoading(false);
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ...deps]);

  return { data, loading, error, reload: run };
}

export function useProjects(): AsyncState<{ cacheDir: string | null; projects: ProjectInfo[] }> {
  return useApi<{ cacheDir: string | null; projects: ProjectInfo[] }>('/projects');
}

export function fmtInt(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return n.toLocaleString('zh-CN');
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function fmtDate(iso: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return iso;
  }
}

export function shortPath(p: string, keep = 3): string {
  if (!p) return '';
  const segs = p.split('/');
  return segs.length <= keep ? p : `…/${segs.slice(-keep).join('/')}`;
}

export function baseName(p: string): string {
  const segs = (p || '').split('/');
  return segs[segs.length - 1] ?? '';
}
