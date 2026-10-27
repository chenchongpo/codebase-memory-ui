import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet } from '../api';
import type { FsList } from '../types';

/**
 * 代码文件夹选择器：服务端列一层目录，前端点进去。
 *
 * 浏览器拿不到原生目录选择框（沙箱限制），因此由服务端 /api/fs/list 提供只读浏览；
 * 也可以直接把路径粘到输入框里回车跳转。
 */
export function DirPicker({
  open,
  initial,
  onClose,
  onPick,
}: {
  open: boolean;
  initial: string;
  onClose: () => void;
  onPick: (path: string) => void;
}) {
  const [path, setPath] = useState(initial);
  const [data, setData] = useState<FsList | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [manual, setManual] = useState(initial);
  const [showHeavy, setShowHeavy] = useState(false);
  const alive = useRef(0);

  const load = useCallback(
    async (target: string) => {
      const id = ++alive.current;
      setLoading(true);
      setErr('');
      try {
        const res = await apiGet<FsList>('/fs/list', { path: target, showHeavy: showHeavy ? '1' : '' });
        if (id !== alive.current) return;
        setData(res);
        setPath(res.path);
        setManual(res.path || '');
        if (res.error) setErr(res.error);
      } catch (e) {
        if (id === alive.current) setErr((e as Error).message);
      } finally {
        if (id === alive.current) setLoading(false);
      }
    },
    [showHeavy]
  );

  useEffect(() => {
    if (!open) return;
    void load(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const rows = data?.entries ?? [];

  return (
    <div className="zoom-overlay" onClick={onClose}>
      <div className="zoom-panel dir-panel" onClick={(e) => e.stopPropagation()}>
        <div className="zoom-head">
          <div className="grow" style={{ minWidth: 0 }}>
            <div style={{ fontSize: 12.5, color: 'var(--fg)' }}>选择代码文件夹</div>
            <div className="tiny dim mono" style={{ marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {data?.rootMode ? '盘符' : path || '—'}
            </div>
          </div>
          <div className="zoom-tools">
            <button className="btn sm" onClick={onClose}>关闭</button>
          </div>
        </div>

        <div className="dir-toolbar">
          <button
            className="btn sm"
            disabled={!data || data.rootMode || !data.parent}
            onClick={() => void load(data?.rootMode ? '' : (data?.parent ?? ''))}
            title="上一级"
          >
            ↑ 上一级
          </button>
          <button className="btn sm" disabled={!data?.rootMode} onClick={() => void load('')} title="回到盘符 / 根">
            盘符
          </button>
          <input
            type="text"
            value={manual}
            spellCheck={false}
            placeholder="直接粘贴路径，回车跳转"
            onChange={(e) => setManual(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void load(manual.trim());
            }}
          />
          <button className="btn sm" onClick={() => void load(manual.trim())}>跳转</button>
          <label className="tiny dim" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer', flex: 'none' }}>
            <input
              type="checkbox"
              checked={showHeavy}
              onChange={(e) => {
                setShowHeavy(e.target.checked);
                void load(path);
              }}
              style={{ width: 13, height: 13 }}
            />
            显示 node_modules 等
          </label>
        </div>

        <div className="dir-list">
          {err && <div className="notice danger" style={{ margin: 10 }}>{err}</div>}
          {loading && !rows.length && <div className="loading" style={{ padding: 18 }}>正在列目录…</div>}
          {!loading && !rows.length && !err && <div className="empty">这一层没有子目录</div>}
          {rows.map((d) => (
            <div key={d.path} className="dir-row" onClick={() => void load(d.path)} title={d.path}>
              <span className="dir-ico">{d.markers.length ? '■' : '▢'}</span>
              <span className="dir-name">{d.name}</span>
              {d.markers.slice(0, 3).map((m) => (
                <span key={m} className="chip tiny-marker">{m}</span>
              ))}
              {d.markers.length > 3 && <span className="tiny dim">+{d.markers.length - 3}</span>}
              <span className="grow" />
              <span className="dir-go">›</span>
            </div>
          ))}
          {data?.truncated && <div className="tiny dim" style={{ padding: '8px 12px' }}>目录太多，只显示前 {rows.length} 项</div>}
          {!!data?.hidden && !showHeavy && (
            <div className="tiny dim" style={{ padding: '8px 12px' }}>
              已隐藏 {data.hidden} 个体积较大的目录（node_modules / target / dist …），需要时勾选上方选项
            </div>
          )}
        </div>

        <div className="dir-foot">
          <div className="grow tiny dim" style={{ minWidth: 0 }}>
            {data?.currentMarkers?.length ? (
              <>当前目录像代码库：<span className="mono">{data.currentMarkers.join(' · ')}</span></>
            ) : (
              '当前目录没有识别到项目文件（pom.xml / package.json / .git 等），仍可选择'
            )}
          </div>
          <button className="btn sm" onClick={onClose}>取消</button>
          <button className="btn primary sm" disabled={!path} onClick={() => onPick(path)}>
            选择此目录
          </button>
        </div>
      </div>
    </div>
  );
}
