/**
 * 渲染自检：用真实 API 数据，把整壳与全部视图逐一挂到 jsdom 上真跑。
 *
 *   npm run check                    （内部自动确保 API 在跑并完成 SSR 打包）
 *   或分两步：
 *     npx vite build --ssr scripts/render-check.tsx --outDir .check
 *     node .check/render-check.js
 *
 * 断言：不抛异常、数据真的渲染出来（不是停在“加载中”）、输出中无 NaN/undefined。
 */
import { JSDOM } from 'jsdom';
import React from 'react';

const API_BASE = process.env.API_BASE ?? 'http://127.0.0.1:8787';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const check = (label: string, ok: boolean, extra = '') => {
  console.log(`   ${ok ? '✓' : '✗'}  ${label}${extra ? `  ${extra}` : ''}`);
  return ok ? 0 : 1;
};

/** 捕获单个视图的渲染崩溃，避免整轮自检被中断 */
class Boundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return React.createElement('div', { className: 'err', 'data-boundary': '1' }, `CRASH: ${this.state.error.message}`);
    }
    return this.props.children;
  }
}

async function main() {
  /* ---------- 环境准备：把 /api 相对路径指向本地服务，并铺好 DOM ---------- */
  const realFetch = globalThis.fetch;
  (globalThis as unknown as { fetch: unknown }).fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' && input.startsWith('/') ? `${API_BASE}${input}` : input;
    return realFetch(url as RequestInfo, init);
  };

  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    url: 'http://127.0.0.1:5273/',
    pretendToBeVisual: true,
  });
  const g = globalThis as unknown as Record<string, unknown>;
  // Node 22 的 globalThis.navigator 是只读 getter，必须用 defineProperty 覆盖
  const define = (k: string, v: unknown) => Object.defineProperty(globalThis, k, { value: v, writable: true, configurable: true });
  define('window', dom.window);
  define('document', dom.window.document);
  define('navigator', dom.window.navigator);
  for (const k of ['HTMLElement', 'SVGElement', 'Element', 'Node', 'Event', 'MouseEvent', 'CSSStyleDeclaration']) {
    define(k, (dom.window as unknown as Record<string, unknown>)[k]);
  }
  define('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  g.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0) as unknown as number;
  g.cancelAnimationFrame = (id: number) => clearTimeout(id);
  Object.assign(dom.window, {
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
  });

  const { createRoot } = await import('react-dom/client');
  const { default: App } = await import('../src/App.tsx');
  const { VIEW_REGISTRY } = await import('../src/views/registry.ts');
  const { VIEWS } = await import('../src/lib/nav.tsx');

  /** 挂载并等待数据到位：轮询到“不再有 .loading 且 DOM 长度稳定”或超时 */
  async function mount(el: Element, node: React.ReactElement, timeout = 9000) {
    const root = createRoot(el);
    root.render(node);
    const t0 = Date.now();
    let lastLen = -1;
    let stable = 0;
    while (Date.now() - t0 < timeout) {
      await sleep(45);
      const len = el.innerHTML.length;
      if (!(el as HTMLElement).querySelector('.loading') && len > 0 && len === lastLen) {
        stable += 1;
        if (stable >= 2) break;
      } else {
        stable = 0;
      }
      lastLen = len;
    }
    return root;
  }

  console.log('\n=== Codebase Insight 渲染自检 ===\n');

  /* ------------------------------ 0. 取真实项目 ------------------------------ */
  const projects = (await (await fetch(`${API_BASE}/api/projects`)).json()) as {
    cacheDir: string;
    projects: { name: string; nodes: number; rootPath: string }[];
  };
  const target = projects.projects[0];
  if (!target) {
    console.error('✗ API 中没有已索引项目');
    process.exit(1);
  }
  console.log(`图数据库目录：${projects.cacheDir}`);
  console.log(`项目：${target.name}（${target.nodes} 节点）\n`);

  /* ------------------------------ 1. 整壳挂载 ------------------------------ */
  let bad = 0;
  const shellEl = dom.window.document.getElementById('root')!;
  await mount(shellEl, React.createElement(App));
  const navCount = shellEl.querySelectorAll('.nav-item').length;
  const title = shellEl.querySelector('h1')?.textContent ?? '';
  console.log('[整壳]');
  bad += check(`侧边导航 ${VIEWS.length} 项`, navCount === VIEWS.length, `实际 ${navCount}`);
  bad += check('项目下拉已填充', shellEl.querySelectorAll('select option').length >= 1);
  bad += check('标题渲染', !!title, title);
  bad += check('首屏无 NaN', !/NaN|\[object Object\]/.test(shellEl.innerHTML));
  bad += check('KPI 卡片已出数', shellEl.querySelectorAll('.kpi').length >= 7, `${shellEl.querySelectorAll('.kpi').length} 个`);

  /* ------------------------------ 2. 逐视图渲染 ------------------------------ */
  console.log('\n[视图]（真实图数据 · 等待数据到位）');
  const host = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(host);
  const timings: string[] = [];

  // 给需要外部输入的视图注入真实载荷，避免只测到空状态
  const PAYLOADS: Record<string, unknown> = {
    search: { query: 'user', token: 1 },
    complexity: { module: 'ruoyi-common' },
    chains: { query: 'SysUserServiceImpl', token: 1 },
    /** 带锚点进来：指标说明页应落在「调用链」小节并高亮 */
    metrics: { query: 'chain', token: 1 },
  };

  for (const [id, Comp] of Object.entries(VIEW_REGISTRY)) {
    const el = dom.window.document.createElement('div');
    host.appendChild(el);
    const t0 = Date.now();
    let err: unknown = null;
    const realError = console.error;
    console.error = () => {}; // React 会把捕获到的错误打到 stderr，这里静音以保持输出可读
    try {
      await mount(
        el,
        React.createElement(
          Boundary,
          null,
          React.createElement(Comp as React.ComponentType<never>, {
            project: target.name,
            nav: () => {},
            openSource: () => {},
            payload: (PAYLOADS[id] as never) ?? null,
          } as never)
        )
      );
    } catch (e) {
      err = e;
    } finally {
      console.error = realError;
    }
    const html = el.innerHTML;
    const ms = Date.now() - t0;
    timings.push(`${id} ${ms}ms`);
    const crash = el.querySelector('[data-boundary]')?.textContent ?? '';
    const stuck = !!el.querySelector('.loading');
    const errBox = el.querySelector('.err')?.textContent ?? '';
    const nan = /NaN|\[object Object\]/.test(html);
    const hasSvg = el.querySelectorAll('svg').length;
    const ok = !err && !crash && !stuck && !errBox && !nan && html.length > 900;
    if (!ok) bad += 1;
    console.log(
      `   ${ok ? '✓' : '✗'}  ${id.padEnd(13)} ${String(html.length).padStart(7)} 字节 ${String(ms).padStart(5)}ms svg×${String(hasSvg).padStart(2)}` +
        (err ? `  抛异常: ${(err as Error).message.slice(0, 110)}` : '') +
        (crash ? `  ${crash.slice(0, 130)}` : '') +
        (stuck ? '  仍停在“加载中”' : '') +
        (errBox ? `  接口错误: ${errBox.slice(0, 110)}` : '') +
        (nan ? '  输出含 NaN/undefined' : '')
    );

    // 链路图专项：正/反向切换、起点列表、调用树绘制、导出与放大入口
    if (id === 'chains') {
      const svgStyle = el.querySelector('svg.chart')?.getAttribute('style') ?? '';
      const btnLabels = [...el.querySelectorAll('button')].map((b) => b.textContent?.trim() ?? '');
      const svgText = [...el.querySelectorAll('svg.chart text')].map((t) => t.textContent ?? '').join(' ');
      bad += check('图按容器宽度缩放', /width:\s*100%/.test(svgStyle), svgStyle.slice(0, 60));
      bad += check(
        '正/反向切换为「调用树 / 时序」',
        btnLabels.some((t) => t.includes('反向调用树')) && btnLabels.some((t) => t.includes('正向时序'))
      );
      bad += check('起点候选列表有数据', el.querySelectorAll('.list-item').length > 0, `${el.querySelectorAll('.list-item').length} 行`);
      /* 「?」帮助弹层 */
      const helpBtn = el.querySelector('.help-btn') as HTMLElement | null;
      if (helpBtn) {
        helpBtn.click();
        await sleep(120);
        bad += check('「?」帮助可点开', !!el.querySelector('.help-pop'));
        helpBtn.click();
      }
      bad += check('起点按模块起算（面包屑 + 模块行）', el.querySelectorAll('.crumb').length === 1 && (el.textContent ?? '').includes('全部模块'));
      bad += check('反向调用树已绘制节点', el.querySelectorAll('svg.chart rect').length > 0, `${el.querySelectorAll('svg.chart rect').length} 个方框`);
      bad += check('树图根节点是「被调用节点」', svgText.includes('被调用节点（根）'));
      bad += check('反向导出树表入口存在', btnLabels.includes('导出树表'));
      bad += check('链路明细带分页条', !!el.querySelector('.pagebar'));
      bad += check('存在「放大」入口', btnLabels.includes('放大'));
      /* 解析溯源：不可靠的跳必须标出来给用户核对，而不是被过滤掉。
         注意不能断言链路明细表 —— 它分页且按层数升序，前几页可能全是可信的短链；
         不做分页的反向调用树才是稳妥的观察点。 */
      const redEdges = [...el.querySelectorAll('svg.chart path, svg.chart line')].filter(
        (n) => n.getAttribute('stroke') === 'var(--danger)'
      ).length;
      bad += check('调用树不可靠跳标红（不隐藏）', redEdges > 0, `${redEdges} 条红色调用边`);
      bad += check('图例说明了标红含义', (el.textContent ?? '').includes('请对照源码核对'));

      /* 逐层下钻：点第一个模块 → 面包屑变两层，出现子包或类 */
      const firstModule = el.querySelector('.list-item') as HTMLElement | null;
      if (firstModule) {
        const moduleName = firstModule.querySelector('.li-t')?.textContent?.trim() ?? '';
        firstModule.click();
        await sleep(900);
        const crumbs = el.querySelectorAll('.crumb').length;
        const hasLevelTag = [...el.querySelectorAll('.list-item')].some((n) => /模块|包|类|方法/.test(n.textContent ?? ''));
        bad += check('点模块可下钻（面包屑 2 层）', crumbs === 2, `${crumbs} 层 · 进入 ${moduleName}`);
        bad += check('下钻后列出子包/类', hasLevelTag && el.querySelectorAll('.list-item').length > 0);
      }

      /* 切到正向：应换成时序图，并带时序表导出 */
      const downBtn = [...el.querySelectorAll('.seg button')].find((b) => (b.textContent ?? '').includes('正向时序')) as HTMLElement | undefined;
      if (downBtn) {
        downBtn.click();
        await sleep(1000);
        const txt2 = [...el.querySelectorAll('svg.chart text')].map((t) => t.textContent ?? '').join(' ');
        const labels2 = [...el.querySelectorAll('button')].map((b) => b.textContent?.trim() ?? '');
        bad += check('正向切换成功（调用树已换成时序画布）', !txt2.includes('被调用节点（根）') && el.querySelectorAll('svg.chart line').length > 0);
        bad += check('时序画布画出参与者与消息', el.querySelectorAll('svg.chart rect').length > 0, `${el.querySelectorAll('svg.chart rect').length} 个参与者框/链路底色`);
        bad += check('时序画布导出入口存在', labels2.includes('导出时序表'), labels2.filter((t) => t.startsWith('导出')).join(' / '));
        /* 全部链路画在同一张画布里：gutter 上的 #n 链路序号应有多条，且不再有逐条翻页按钮 */
        const bandLabels = [...el.querySelectorAll('svg.chart text')].filter((t) => /^#\d+$/.test((t.textContent ?? '').trim())).length;
        bad += check('时序画布一次画出全部链路', bandLabels > 1, `${bandLabels} 条链路带`);
        bad += check('已移除逐条翻页按钮', !labels2.some((t) => t.includes('下一条')));
        bad += check('时序画布无 NaN', !/NaN/.test(el.innerHTML));
        /* 时序图一次只画一条链（按层数升序取第 1 条），那条链未必含不可靠跳，
           所以这里只验证「不可靠跳」KPI 有数、红色的语义仍然在位。 */
        bad += check('不可靠跳 KPI 已出数', /不可靠跳/.test(el.textContent ?? ''));
      }
    }
    // 总览专项：节点/边类型分布已合并为一张卡，右上角切换
    if (id === 'overview') {
      const segs = [...el.querySelectorAll('.seg button')].map((b) => b.textContent?.trim() ?? '');
      bad += check('类型分布卡片带节点/边切换', segs.some((t) => t.startsWith('节点')) && segs.some((t) => t.startsWith('边')), segs.join(' | '));
    }
    // 依赖与分层专项：三档切换（模块 / 包 / 分层）都要能画出来
    if (id === 'deps') {
      const text = el.textContent ?? '';
      const segs = [...el.querySelectorAll('.seg button')].map((b) => b.textContent?.trim() ?? '');
      bad += check('三档切换齐全（模块/包/分层）', ['模块', '包', '分层'].every((t) => segs.includes(t)), segs.join(' | '));
      bad += check('模块依赖力导向图已渲染', el.querySelectorAll('svg.chart circle').length > 0, `${el.querySelectorAll('svg.chart circle').length} 个节点`);
      bad += check('模块明细已出数', text.includes('模块明细'));
      const layerBtn = [...el.querySelectorAll('.seg button')].find((b) => (b.textContent ?? '').trim() === '分层') as HTMLElement | undefined;
      if (layerBtn) {
        layerBtn.click();
        await sleep(600);
        bad += check('切到分层后画出跨层矩阵', (el.textContent ?? '').includes('跨层调用矩阵'));
        bad += check('分层页无 NaN', !/NaN/.test(el.innerHTML));
      }
    }
    // 指标说明专项：口径字典要在，且带锚点进来能落到对应小节
    if (id === 'metrics') {
      const text = el.textContent ?? '';
      bad += check('口径小节齐全', el.querySelectorAll('.met-sec').length >= 8, `${el.querySelectorAll('.met-sec').length} 个小节`);
      bad += check('小节跳转条存在', el.querySelectorAll('.met-chip').length >= 8);
      bad += check('已覆盖复杂度与指纹口径', text.includes('圈复杂度') && text.includes('结构指纹'));
      bad += check('带锚点落在对应小节（调用链）', !!el.querySelector('.met-sec.focus') && !!el.querySelector('#met-chain'));
    }
    // 配置专项：代码索引卡片（选文件夹 → 调 MCP 索引）
    if (id === 'settings') {
      const labels = [...el.querySelectorAll('button')].map((b) => b.textContent?.trim() ?? '');
      bad += check('存在「开始索引」入口', labels.includes('开始索引'));
      bad += check('存在「浏览…」目录选择入口', labels.includes('浏览…'));
      bad += check(
        '代码库根路径字段存在',
        [...el.querySelectorAll('.cfg-label span')].some((s) => (s.textContent ?? '').includes('代码库根路径'))
      );
      bad += check('索引日志控制台存在', !!el.querySelector('.idx-console'));
      bad += check(
        '索引模式三档可选',
        ['完整', '适中', '快速'].every((t) => [...el.querySelectorAll('.seg button')].some((b) => (b.textContent ?? '').trim() === t))
      );
      bad += check(
        '索引服务支持两种传输',
        ['HTTP', 'stdio'].every((t) => [...el.querySelectorAll('.seg button')].some((b) => (b.textContent ?? '').trim() === t))
      );

      const browse = [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === '浏览…') as HTMLElement | undefined;
      browse?.click();
      await sleep(800);
      const dirRows = el.querySelectorAll('.dir-row').length;
      bad += check('目录选择器能列出目录', dirRows > 0, `${dirRows} 行`);
      bad += check('目录选择器有「选择此目录」', [...el.querySelectorAll('.dir-foot button')].some((b) => (b.textContent ?? '').includes('选择此目录')));
      const cancel = [...el.querySelectorAll('.dir-foot button')].find((b) => b.textContent?.trim() === '取消') as HTMLElement | undefined;
      cancel?.click();
      await sleep(200);
      bad += check('目录选择器可关闭', !el.querySelector('.dir-row'));
    }
    // 列表专项：复杂度与接口清单都带分页条
    if (id === 'complexity' || id === 'routes' || id === 'deadcode') {
      bad += check('明细列表带分页条', !!el.querySelector('.pagebar'));
    }
    el.remove();
  }

  console.log(`\n耗时：${timings.join(' · ')}`);
  console.log(bad === 0 ? '\n✅ 全部通过\n' : `\n❌ ${bad} 项异常\n`);
  process.exit(bad === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('自检脚本异常：', e);
  process.exit(1);
});
