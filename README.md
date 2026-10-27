# Codebase Insight

把代码图数据库变成**可读的十张视图**：复杂度分布、重复热点、无引用代码、调用链、依赖与分层、接口地图……

面向的是「接手一个陌生仓库时，如何在十分钟内看出它哪里有问题」——不是又一棵文件树。

![十视图](https://img.shields.io/badge/views-10-blue) ![node](https://img.shields.io/badge/node-%E2%89%A522.5-green) ![license](https://img.shields.io/badge/license-MIT-black)

---

## 它是什么 / 不是什么

**是**：一个只读的分析前端。数据来自索引器（tree-sitter AST）产出的 SQLite 图数据库，后端是零 npm 依赖的 Node HTTP 服务，前端是 React + Vite。

**不是**：不是 IDE 插件，不做代码生成，**不含任何大模型调用**——所有指标都是确定性 SQL 聚合与规则引擎算出来的，同一份代码每次跑出的数字都一样。

## 十张视图

| 视图 | 回答什么问题 |
|---|---|
| **总览** | 这个仓库有多大、复杂度长什么样、索引覆盖全不全 |
| **复杂度分布** | 哪些函数该重构（圈复杂度 / 认知复杂度 / 循环深度 / 散点 + 分档 + 明细） |
| **重复热点** | 哪些实现是复制粘贴的（结构指纹 `fp` 完全一致 vs `SIMILAR_TO` 相似） |
| **无引用代码** | 哪些代码没人调（按 low / review / keep 分级，标出删前必查的盲区） |
| **链路图** | 改这个方法会影响哪些入口 / 一次请求最终落到哪里（调用树 + 全链路时序画布） |
| **依赖与分层** | 哪些模块耦在一起、分层有没有被击穿（模块图 / 包图 / 跨层矩阵 三档切换） |
| **接口地图** | 对外暴露了哪些 HTTP 接口、哪些路由没绑上处理器 |
| **检索与源码** | 全文检索 + 节点邻接 + 源码片段 |
| **指标说明** | 每个数字到底怎么算的、可信边界在哪（口径字典，其它页会带锚点跳过来） |
| **配置** | 索引服务、图库目录、分析口径 |

## 快速开始

```bash
# 需要 Node ≥ 22.5（用到内置 node:sqlite）
npm install

# 1) 先准备一份图数据库：用索引器解析你的仓库（见下节）
# 2) 把图库目录告诉本服务（默认会自动探测 D:/cbm-cache 或 ~/.cbm-cache）
# 3) 起开发环境：API 8787 + Vite 5273
npm run dev
# 打开 http://localhost:5273
```

生产模式（单端口同时托管前端与 API）：

```bash
npm run build
npm start          # 打开 http://127.0.0.1:8787
```

常用环境变量：`CBM_CACHE_DIR`（图库目录）、`PORT`、`HOST`、`LOG=0`（关闭逐请求日志）。

## 索引服务：HTTP 或 stdio 都支持

本服务通过 **MCP** 调用索引器（`index_repository`），两种传输任选，在「配置 → 索引服务」里切换：

| 传输 | 适合场景 | 配置 |
|---|---|---|
| **http** | 团队共享一台索引机；本机不放原生二进制 | 端点地址（如 `http://127.0.0.1:7801/mcp`）+ 可选 Bearer Token |
| **stdio** | 单机 / 离网 | `codebase-memory-mcp` 可执行文件路径（留空自动探测 npm 全局位置） |

配好后点「检测」验证连通性。也可以直接改 `config/app.config.json`（从 `config/app.config.example.json` 复制），或用环境变量 `CBM_ENDPOINT` / `CBM_TOKEN` / `CBM_EXE` 覆盖。

## 数据从哪来

索引器为每个仓库落一个 SQLite 文件（文件名即项目名），核心是两张表：

- `nodes`：`Project / Folder / File / Class / Interface / Enum / Method / Function / Field / Variable / Route / Module …`
- `edges`：`CALLS / IMPORTS / DEFINES / USAGE / OVERRIDE / IMPLEMENTS / INHERITS / HANDLES / SIMILAR_TO …`
- 方法节点的 `properties` 里带预计算好的指标：`complexity`、`cognitive`、`loop_depth`、`lines`、`fp` 等

本服务**只读**这些库（`SELECT`），不生任何副作用。想了解每个字段的含义与可信边界，看站内「指标说明」页。

## 百万节点下也不慢

查询层做过针对性优化（实测 100 万节点 / 1100 万边合成库）：

| 优化 | 做法 |
|---|---|
| 物化分析副库 | 方法指标解析一次落成普通列 + 复合索引（`server/analytics.mjs`），之后分档/分位/分页全走索引 |
| 索引真正生效 | 所有查询带 `project` 前缀条件（库内索引都以它打头，漏了就退化全表扫描） |
| 去掉全量载入 | 调用链改成按需邻居查询；`COUNT(*)` 类统计加缓存 |
| 响应封顶 | 重复热点明细与散点采样都有上限，避免几十 MB 的响应把前端打死 |
| 结果缓存 | 按「库版本 + 接口 + 参数」缓存，重新索引自动失效 |

## 项目结构

```
server/                 零 npm 依赖后端
  index.mjs             HTTP 服务：路由 / 静态托管
  queries.mjs           全部聚合查询（各视图的指标口径都在这里）
  analytics.mjs         分析副库：指标物化 + 结果缓存
  mcp.mjs               MCP 客户端：http / stdio 双传输
  indexer.mjs           索引任务（单任务串行 + 进度日志）
  db.mjs / config.mjs / paths.mjs / fsbrowse.mjs
src/                    React 前端
  views/                十个视图 + registry.ts
  components/           图表（力导向 / 分层流 / 调用树 / 时序画布）、通用 UI
  lib/                  导航契约、链路模型、CSV 导出
scripts/                dev.mjs（一键起前后端）、check.mjs + render-check.tsx（渲染自检）
```

## 开发

```bash
npm run dev      # 前后端一起起
npm run check    # 渲染自检：用真实图数据把整壳与十个视图逐个挂到 jsdom 上跑
```

`npm run check` 会断言每个视图不崩溃、不停在加载态、无 `NaN`，并对关键交互（下钻、正反向切换、时序画布全量链路、不可靠跳标红等）逐项检查。改前端后请务必跑一遍。

## 贡献

欢迎 issue 与 PR。提交前请：

1. `npm run check` 通过；
2. 新增指标时，同步更新「指标说明」页（`src/views/Metrics.tsx`）——口径和实现必须写在一起，否则半年后没人说得清这个数字是怎么来的；
3. 保持后端零 npm 依赖：`server/` 只用 Node 内置模块。

## 许可

[MIT](LICENSE)
