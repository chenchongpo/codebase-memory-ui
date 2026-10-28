import { useEffect, useMemo, useRef, useState } from 'react';
import { Card } from '../components/ui';
import type { ViewProps } from '../lib/nav';

/**
 * 指标口径说明。
 *
 * 存在的理由：各视图原来各自带一大段散文式说明，同一个概念（复杂度档位、指纹、
 * 「无引用」口径、解析溯源）在多处重复且口吻不一。这里集中成一份口径字典，
 * 其它视图只留一句怎么用 + 「查看指标口径 ›」跳过来并定位到对应小节。
 *
 * 原则：只写本工程**实际**使用的口径，并标明数据的可信边界（哪些东西本来就不在图里）。
 */

interface DefRow {
  /** 指标名 */
  k: string;
  /** 释义与算法 */
  v: string;
  /** 可信边界 / 易误读之处 */
  caveat?: string;
}

interface Section {
  id: string;
  title: string;
  sub: string;
  rows: DefRow[];
  /** 补充说明（列表形式） */
  notes?: string[];
}

const SECTIONS: Section[] = [
  {
    id: 'source',
    title: '数据来源与可信边界',
    sub: '所有数字都从图数据库读出来，本工程不做二次解析',
    rows: [
      { k: '解析器', v: 'codebase-memory-mcp 内置的 tree-sitter AST：纯本地运行，不发网络请求，不需要 API Key。' },
      { k: '存储', v: '每个仓库一个 SQLite（nodes / edges + 预计算好的 properties），本工程只做只读 SELECT 与确定性聚合。' },
      { k: '不参与', v: '本工程的分析链路不调用大模型：所有指标来自 AST 与 SQL 聚合，结果可复现。' },
      {
        k: '图里没有的东西',
        v: '反射与动态代理（Class.forName / getBean）、AOP 代理、XML 配置里的调用、MyBatis 动态 SQL、前端通过字符串拼出来的路由。',
        caveat: '这些「无人调用」在静态图里看不出来，所以死代码结论一律只作线索，最终要人工核对。',
      },
    ],
  },
  {
    id: 'node-edge',
    title: '节点与边',
    sub: '图的基本单位，也是所有视图的数据接口',
    rows: [
      { k: '节点（16 类）', v: 'Project / Branch / Folder / File / Class / Interface / Enum / Method / Function / Field / Variable / Route / Table / Decorator / Section / Module' },
      {
        k: '边（19 类）',
        v: 'CALLS / IMPORTS / DEFINES / DEFINES_METHOD / HANDLES / USAGE / WRITES / INHERITS / IMPLEMENTS / OVERRIDE / SIMILAR_TO / SEMANTICALLY_RELATED / CONTAINS_FILE / CONTAINS_FOLDER / THROWS / TESTS / DECORATES / HTTP_CALLS / HAS_BRANCH',
      },
      {
        k: '结构边 vs 语义边',
        v: 'DEFINES、DEFINES_METHOD、CONTAINS_* 是结构边——任何节点都天然带，不能当成「被引用」；只有 CALLS、USAGE、IMPORTS、OVERRIDE 这类才说明「有人用了它」。',
      },
      {
        k: 'CALLS 的收口',
        v: '调用边的目标必须落在 Method / Function 上。索引器在类型推断失败时会退化成名字匹配，把 new Xxx()、变量读写误判成调用，目标落到 Field / Variable / Route 上；本工程在查询层统一剔除这类脏边。',
        caveat: 'RuoYi 样本里这类脏边有 171 条（如一条「调用」指向名为 open 的变量），已在所有视图统一排除。',
      },
    ],
  },
  {
    id: 'complexity',
    title: '复杂度指标',
    sub: '圈复杂度、认知复杂度、循环与圈味',
    rows: [
      {
        k: '圈复杂度 complexity',
        v: '函数内独立判定路径的条数，由索引器在 AST 上算好（≈ 判定分支数 + 1）。数字越大，需要的测试用例越多。',
        caveat: '分档：≤5 / 6–10 / 11–20 / 21–40 / 40+。> 10 记为高复杂度函数。P50 / P75 / P90 / P95 / P99 用最近的秩，不做插值。',
      },
      {
        k: '认知复杂度 cognitive',
        v: '按嵌套层数与控制流中断加权，衡量「人读起来有多绕」。嵌套越深惩罚越重，连续短分支惩罚较轻。',
        caveat: '它不等于圈复杂度：两个函数可以圈复杂度相同、认知复杂度差很多。重构优先级建议两者一起看。',
      },
      { k: 'loop_count / loop_depth', v: '循环语句个数；循环的最大嵌套层数。' },
      {
        k: 'transitive_loop_depth',
        v: '把被它调用的方法的循环深度也算进来的传递嵌套深度，用于发现「自己一层循环、但调下去还有三层」的隐性热路径。',
      },
      { k: 'param_count / max_access_depth', v: '参数个数；链式访问（a.b.c.d）的最大深度。' },
      { k: 'linear_scan_in_loop', v: '循环体内做线性扫描（如 contains / indexOf / 遍历查找）——典型的隐性 O(n²) 信号。' },
      { k: 'alloc_in_loop', v: '循环体内创建对象或扩容容器，可能带来频繁 GC 压力。' },
      { k: 'recursion_in_loop / unguarded_recursion / self_recursive', v: '循环内递归；缺少终止保护的递归；直接自递归。' },
      { k: 'lines', v: '函数体行数。总览的「代码行数」= 所有函数体 lines 之和（AST 口径，不是文件的物理行数）。' },
    ],
    notes: [
      '高复杂度阈值全工程统一为圈复杂度 > 10（即从「11–20」档起算）：总览的「高复杂度函数」、分层图的「超 10 的函数」用的是同一个常量，不要按 > 5 理解。',
    ],
  },
  {
    id: 'duplicate',
    title: '重复与指纹',
    sub: '结构指纹 fp 与相似边 SIMILAR_TO 是两套东西',
    rows: [
      {
        k: '结构指纹 fp',
        v: '索引器对函数体结构算出的指纹。fp 完全相同 = 同一份实现被复制到了多处，变量名与注释不同不影响结果。',
        caveat: '这是「可以净删冗余」的强证据：保留一份、其余合并，收益可估算。',
      },
      {
        k: 'SIMILAR_TO 与 jaccard',
        v: '结构相似度，取值 0–1，越高越像。它是「看起来像」，不是「结构完全相同」。',
        caveat: '相似不等于可以合并：三者相似的函数可能只是都做了参数校验，语义完全不同。改之前务必读代码。',
      },
      {
        k: '重复簇',
        v: 'SIMILAR_TO 边的连通分量：簇内实现两两结构相似。一个函数可能同时属于多个簇。',
      },
      {
        k: '可回收代码量',
        v: '估算值 = 簇（或指纹组）内总行数 − 最大成员行数，即「同类只留一份」能省下的行数。',
        caveat: '是上限估计，不含抽取公共方法、调整调用点的工作量。',
      },
    ],
  },
  {
    id: 'refs',
    title: '引用与无引用代码',
    sub: '「无引用」到底是怎么判的',
    rows: [
      {
        k: '「被引用」的入边口径',
        v: 'Method / Function：CALLS、USAGE、OVERRIDE；Class / Interface / Enum：USAGE、CALLS、IMPORTS、INHERITS、IMPLEMENTS、DECORATES、THROWS；Field / Variable：USAGE、WRITES、CALLS。',
        caveat: '结构边不算引用。CALLS 目标不是方法的脏边也不算（见「节点与边」）。',
      },
      {
        k: '接口派发闭包',
        v: '实现方法的调用边其实落在接口方法上（OVERRIDE 方向是「实现 → 接口」），所以只要接口方法被调用过，它的所有实现方法都算被引用。',
        caveat: '没有这层闭包，Spring 的 Service 实现会成片地误报成无引用（RuoYi 样本里约 150 个方法）。',
      },
      {
        k: '分级 low / review / keep',
        v: '依次判定：测试代码 → 框架入口（is_entry_point / route）→ 语言约定名（main / toString / equals…）→ 运行时注解（@Scheduled / @EventListener / @Bean…）→ 被实现或重写 → MyBatis Mapper → 字段变量 → 类 → 方法。命中即停，后面的不再判。',
        caveat: 'low 才建议直接删；review 必须确认调用方后处置；keep 基本不该动。',
      },
      {
        k: '字段与变量为什么统一「低置信」',
        v: 'getter/setter、JSON 序列化、ORM 映射都不产生 USAGE 边，字段级引用在图里本就不完整。',
        caveat: '所以字段永远只进「需复核」，不会被判为可直接删除。',
      },
      {
        k: '动态语言降级',
        v: 'Python / TS / JS 的反射、装饰器路由、动态派发不入图，这类项目的无引用方法一律归「需复核」，不直接判可删。',
      },
    ],
    notes: [
      '删除前必查四类盲区：① 反射与动态代理（Class.forName / getBean / MyBatis XML）；② 配置与注解驱动（@Scheduled / @EventListener / @KafkaListener / @PostConstruct）；③ 对外契约（DTO/VO 字段、序列化方法、被外部系统依赖的接口）；④ 开关与灰度（配置开关控制、当前未启用的分支）。',
      '删除顺序：先低风险 → 再需复核；单批不超过 10 个文件或 200 行，独立提交、独立回归；按代码 → 配置 → 依赖的顺序清理。',
    ],
  },
  {
    id: 'chain',
    title: '调用链与解析溯源',
    sub: '链路怎么画，以及哪些跳不可信',
    rows: [
      { k: '反向（调用树）', v: '根 = 被调用节点，向右逐层展开「谁调用了它」。改签名前用它确认会影响哪些入口。' },
      {
        k: '正向（时序画布）',
        v: '全部链路竖着堆在同一张画布里，参与者列按调用时序排（入口类最左，越右被调得越晚），因此同一个类固定在同一列。从上往下就是执行顺序，纵向扫一列即可比较各条链路。',
        caveat: '行数超上限时会少画尾部链路并提示；多列时保留 35% 可读性下限，宁可横向滚动也不把字压到看不清。',
      },
      {
        k: '深度',
        v: '指调用层数，不是部署包引用层级：a 调 b、b 里调 c 算 2 层——深度 1 只展示 b，深度 2 展示 b 和 c。每一跳算一层，接口派发也算一层。',
        caveat: '层数越深越容易触到条数上限，先用 3–4 层定位再加深。',
      },
      {
        k: '接口派发',
        v: '调用点常常落在接口方法上，用 OVERRIDE 边跨到实现方法，图与明细里标为黄色虚线。',
        caveat: '没有这层跳转，Spring 的 Service 实现会显示成「无人调用」。',
      },
      {
        k: '解析溯源：有类型依据（exact）',
        v: 'LSP 类型派发、字段类型提示、限定名、同模块、import 映射——都是靠类型信息解出来的，可以直接采信。',
      },
      {
        k: '解析溯源：唯一同名推断（inferred）',
        v: '没有类型信息，但全项目只有一个同名方法，按名字认定。通常正确，但没有类型依据，界面用淡黄下划线提示。',
      },
      {
        k: '解析溯源：推断不可靠（suspect）',
        v: '靠后缀匹配从多个同名候选里挑了一个，或根本没有解析记录。界面**标红 ⚠ 并附悬停说明**，不隐藏、不过滤。',
        caveat: '典型错法是把外部调用的目标错接到项目内同名方法：Map.put → CacheUtils.put、Field.getType → SpringUtils.getType、Logger.error → AjaxResult.error。看到红箭头请对照源码核对。',
      },
      {
        k: '为什么不用置信度阈值',
        v: '置信度数值与实际对错并不对齐：唯一同名的边只给 0.38 却通常是对的，后缀匹配给 0.55 却常常接错。所以按解析策略分档、把不可信的标出来交给用户核对，而不是按分数过滤。',
      },
    ],
  },
  {
    id: 'depend',
    title: '依赖与分层',
    sub: '架构图与分层图的口径',
    rows: [
      {
        k: '模块依赖 / 包依赖',
        v: '由 IMPORTS 边按目录首段（模块）或包名聚合，权重 = 聚合到的 IMPORTS 边数。',
        caveat: '只反映编译期 import，运行期依赖（反射加载、消息队列、远程调用）不在此列。',
      },
      {
        k: '归层规则',
        v: '按文件路径正则**首个命中**归层：L0 接入（页面/静态资源）→ L1 接口（Controller/Route）→ L2 应用服务（Service/Aspect/任务）→ L3 领域模型（domain/entity/dto/vo）→ L4 持久化（Mapper/DAO/SQL）→ L5 公共基础（common/util/config）→ LX 其他。',
        caveat: '这是路径启发式，不是架构声明。目录命名不规范的工程会被归到 LX，此时分层图参考价值有限。',
      },
      {
        k: '跨层调用',
        v: 'CALLS 边两端的文件分属不同层即计入，按「起点层 → 终点层」聚合强度。',
        caveat: '跨层不一定是坏事；倒流（下层调用上层，如持久化层直接调 Controller）才通常是设计问题。',
      },
    ],
  },
  {
    id: 'api',
    title: '接口地图',
    sub: '对外暴露面',
    rows: [
      { k: 'Route 节点', v: '索引器识别出的 HTTP 路由，带方法与路径。' },
      { k: 'HANDLES 边', v: 'Route → 处理方法，表示这条路由由哪个方法处理。' },
      {
        k: '绑定覆盖率',
        v: '有 HANDLES 边指向的 Route 占全部 Route 的比例。',
        caveat: '未绑定不等于坏接口：可能是框架内部路由、注解组合写法或索引未识别。',
      },
    ],
  },
  {
    id: 'coverage',
    title: '索引覆盖率与模式',
    sub: '先确认数据全不全，再看指标',
    rows: [
      {
        k: '覆盖率三类',
        v: '未索引目录（not_indexed_dir）、未索引文件（not_indexed_file）、部分解析失败（parse_partial）——直接来自索引器的 index_coverage 表。',
        caveat: '覆盖率低时，所有「无引用」「无测试」类结论都会虚高，先修索引再看报表。',
      },
      {
        k: '索引模式',
        v: '完整（full）= 结构 + 语义；适中（moderate）= 过滤后再做语义；快速（fast）= 只做结构解析，不建语义边。',
        caveat: 'fast 模式下 SIMILAR_TO / SEMANTICALLY_RELATED 这类语义边不存在，重复热点视图会明显偏空，这不是 bug。',
      },
    ],
  },
];

export default function Metrics({ payload }: ViewProps) {
  const want = (payload?.query ?? '').trim();
  const [focus, setFocus] = useState<string | null>(null);
  const refs = useRef<Record<string, HTMLDivElement | null>>({});

  const valid = useMemo(() => SECTIONS.some((s) => s.id === want), [want]);

  useEffect(() => {
    if (!want) return;
    const el = refs.current[want];
    if (!el) return;
    setFocus(want);
    // jsdom 等无滚动实现的环境没有 scrollIntoView，不能直接调
    el.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    const t = setTimeout(() => setFocus(null), 2200);
    return () => clearTimeout(t);
  }, [want, payload?.token]);

  const jump = (id: string) => {
    setFocus(id);
    refs.current[id]?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    window.setTimeout(() => setFocus(null), 2200);
  };

  return (
    <>
      <div className="met-toc">
        <span className="met-toc-label">跳到</span>
        {SECTIONS.map((s) => (
          <button key={s.id} type="button" className={`met-chip ${valid && want === s.id ? 'on' : ''}`} onClick={() => jump(s.id)}>
            {s.title}
          </button>
        ))}
      </div>

      {SECTIONS.map((s) => (
        <div
          key={s.id}
          ref={(el) => {
            refs.current[s.id] = el;
          }}
          className={`met-sec ${focus === s.id ? 'focus' : ''}`}
          id={`met-${s.id}`}
        >
          <Card title={s.title} hint={s.sub}>
            <table className="tbl met-tbl">
              <tbody>
                {s.rows.map((r) => (
                  <tr key={r.k}>
                    <td className="met-k">{r.k}</td>
                    <td>
                      <div>{r.v}</div>
                      {r.caveat && <div className="met-caveat">注意：{r.caveat}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {s.notes?.length ? (
              <ul className="met-notes">
                {s.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            ) : null}
          </Card>
        </div>
      ))}
    </>
  );
}
