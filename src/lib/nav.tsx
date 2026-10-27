/** 视图间跳转与外部源码打开的统一契约 */
export interface NavPayload {
  /** 跳到复杂度视图并聚焦某模块 */
  module?: string;
  /** 跳到检索视图并填入关键词 / 定位节点 */
  query?: string;
  nodeId?: number;
  /** 直接打开某文件的源码片段（由 openSource 传入） */
  file?: string;
  line?: number;
  /** 每次 openSource 递增，用于强制刷新同一路径的定位 */
  token?: number;
}

export interface ViewProps {
  project: string;
  nav: (view: ViewId, payload?: NavPayload) => void;
  openSource: (file: string, line?: number) => void;
  payload: NavPayload | null;
  /** 重新拉取项目列表（配置变更后刷新侧边栏） */
  refresh?: () => void;
  /** 切换左侧当前项目（索引完成后跳过去） */
  selectProject?: (name: string) => void;
}

export type ViewId =
  | 'overview'
  | 'complexity'
  | 'duplicates'
  | 'deadcode'
  | 'chains'
  | 'deps'
  | 'routes'
  | 'search'
  | 'metrics'
  | 'settings';

export const VIEWS: { id: ViewId; label: string; icon: string; group: string; title: string; sub: string }[] = [
  { id: 'overview', label: '总览', icon: 'grid', group: '代码体检', title: '项目总览', sub: '从 codebase-memory 图数据库聚合的全局指标' },
  { id: 'complexity', label: '复杂度分布', icon: 'activity', group: '代码体检', title: '函数复杂度分布', sub: '散点 + 分档直方图 + TOP 榜' },
  { id: 'duplicates', label: '重复热点', icon: 'copy', group: '代码体检', title: '重复实现热点', sub: '基于 SIMILAR_TO 边与结构指纹聚类' },
  { id: 'deadcode', label: '无引用代码', icon: 'trash', group: '代码体检', title: '无引用代码报表', sub: '零调用/零引用的类与方法，按模块汇总并分级' },
  { id: 'chains', label: '链路图', icon: 'arrow', group: '结构视图', title: '调用链路图', sub: '从模块 → 包 → 类 → 方法逐层选起点；反向画调用树（根 = 被调用节点）、正向画时序图，图与明细均可导出表' },
  { id: 'deps', label: '依赖与分层', icon: 'layers', group: '结构视图', title: '依赖与分层', sub: '模块/包级依赖聚合 + 按职责归层 + 跨层调用矩阵' },
  { id: 'routes', label: '接口地图', icon: 'link', group: '结构视图', title: '接口路由地图', sub: 'Route 节点与 HANDLES 边构成的 API 面' },
  { id: 'search', label: '检索与源码', icon: 'search', group: '工具', title: '检索与源码', sub: 'FTS 全文检索 + 节点邻接 + 源码片段' },
  { id: 'metrics', label: '指标说明', icon: 'book', group: '工具', title: '指标口径说明', sub: '复杂度、指纹、引用口径、调用链溯源等全部指标的定义与可信边界' },
  { id: 'settings', label: '配置', icon: 'sliders', group: '工具', title: '工具与代码配置', sub: '选代码文件夹触发 MCP 索引、图数据库路径、源码映射、大模型接入与分析口径' },
];

export const ICONS: Record<string, string> = {
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  activity: 'M3 12h4l3-8 4 16 3-8h4',
  copy: 'M8 8h11v11H8zM5 16V5h11',
  arrow: 'M4 6h10M4 12h14M4 18h8M17 15l3 3-3 3',
  layers: 'M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5',
  stack: 'M4 4h16v4H4zM4 10h16v4H4zM4 16h16v4H4z',
  link: 'M10 13a5 5 0 007 0l2-2a5 5 0 00-7-7l-1 1M14 11a5 5 0 00-7 0l-2 2a5 5 0 007 7l1-1',
  search: 'M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.3-4.3',
  book: 'M4 5.5A2.5 2.5 0 016.5 3H19v15H6.5A2.5 2.5 0 004 20.5zM4 5.5v15M8 7h7M8 11h7',
  trash: 'M4 7h16M9 7V5h6v2M6.5 7l1 13h9l1-13M10 11v5M14 11v5',
  sliders: 'M4 7h9M17 7h3M4 12h3M11 12h9M4 17h9M17 17h3M13 5v4M8 10v4M13 15v4',
};

export function Icon({ name, size = 15 }: { name: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" className="nav-ico">
      <path d={ICONS[name] ?? ICONS.grid} />
    </svg>
  );
}
