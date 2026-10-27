/** 视图注册表：统一 id → 组件映射，供 App 路由与渲染自检复用 */
import type { ComponentType } from 'react';
import type { ViewId, ViewProps } from '../lib/nav';

import Overview from './Overview';
import Complexity from './Complexity';
import Duplicates from './Duplicates';
import DeadCode from './DeadCode';
import Chains from './Chains';
import Deps from './Deps';
import Routes from './Routes';
import Search from './Search';
import Metrics from './Metrics';
import Settings from './Settings';

export const VIEW_REGISTRY: Record<ViewId, ComponentType<ViewProps>> = {
  overview: Overview,
  complexity: Complexity,
  duplicates: Duplicates,
  deadcode: DeadCode,
  chains: Chains,
  deps: Deps,
  routes: Routes,
  search: Search,
  metrics: Metrics,
  settings: Settings,
};

export type { ViewId, ViewProps };
