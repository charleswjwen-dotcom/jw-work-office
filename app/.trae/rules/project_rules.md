# My-work-office 项目规则（协作 Agent 必读）

> 本文件供 TRAE 及协作 Agent 自动遵守。人类开发者引导见 `app/README.md`。
> 工作目录约定：代码工程在 `app/`，治理文档在仓库根目录。

## 1. 唯一事实来源：治理四文档

实现决策以下列文档为准，**代码不得偏离文档口径；若需偏离，先改文档再改代码**。

- `需求文档.md`（PRD v2.1）— 产品需求、范围、验收口径
- `架构设计文档.md`（HLD v1.2）— 进程模型、引擎选型、数据/变更模型
- `后续工作计划.md`— 阶段划分与阶段门禁
- `开发任务清单.md`（**开发主基准**）— 可执行任务分解（T-Sx-xx），每项带 `[x]` 证据

**每次开工前**：读 `开发任务清单.md`，定位最近完成项与下一个 `[ ]` 任务。
**每完成一项**：在清单对应子项打 `[x]` 并追加「证据：文件/用例」，禁止无证据勾选。

## 2. 五道质量门禁（不通过不算完成，不进入下一任务）

在 `app/` 目录依次执行，必须全绿：

```bash
npm run typecheck   # 双 tsc（node + web）
npm run lint        # eslint，严格模式
npm test            # vitest（Node 环境单元/集成测试）
npm run build       # electron-vite 生产构建
npm run test:e2e    # playwright（Electron 冒烟 + 数据层就绪断言）
```

- 只标注**真正完成且有证据**的任务；有偏差要**诚实披露**（如某字段依赖未集成能力则置 null 并注释原因）。
- 严禁伪造数据/结果。不确定的事实用工具查证，不猜测。

## 3. better-sqlite3 双 ABI 约束（重要，勿踩坑）

- **版本锁定 `better-sqlite3@12.11.1`**，**禁止升级到 v13**（v13 用 N-API 10，Electron 33 内置 Node 20 仅 N-API 9，`new Database()` 必 SIGSEGV）。
- 原生模块存在双 ABI 机制：
  - Electron 运行时（含 DB Utility 进程）用 `node_modules/better-sqlite3/build/Release`（Electron ABI，modules=130）。
  - vitest（Node）经 `src/main/db/connection.ts` 的 `resolveNativeBinding()` 注入 `vendor/better-sqlite3/better_sqlite3.node-abi.node`（Node ABI）。
- **`vendor/better-sqlite3/` 目录不可删**（双 ABI 产物 + 说明）。
- 遇 `NODE_MODULE_VERSION` 报错或 DB 崩溃：先 `npm run rebuild:electron`；若仍异常，按 `vendor/better-sqlite3/README.md` 恢复两份产物。
- `npm install` / `npm rebuild` 之后可能改写 build/Release 为 Node ABI → 跑 Electron/e2e 前务必 `npm run rebuild:electron`。

## 4. 代码约定

- **注释写「架构意图」**：解释"为什么这样设计"，方便后续优化时理解此前架构；关键约束标注「勿删」，并引用相关任务号/历史缺陷。
- 代码标识符用英文（遵循项目既有风格）；注释用中文。
- 遵循既有模式：新增前先看邻近文件的框架/命名/类型约定，不擅自引入未在 `package.json` 声明的库。
- 数据库迁移必须**幂等**（`connection.ts` 已实现 `__mwo_migrations` 记账表 + 基线检测，勿破坏该机制）。
- 进程隔离：文件解析（CPU 密集）与 SQLite 写库分属两个 Utility 进程，勿合并（架构 §2、§3.4）。

## 5. 进度落点（截至最近一次更新）

- 已完成：S0 PoC 主体、S1 设计冻结、**T-S2-01/02/03**（工程骨架 / SQLite+Drizzle 数据层 / Word 导入全链路）。
- `src/main/llm`、`src/main/tools`、`src/main/agent` 为 **T-S0-05 PoC 遗留骨架，尚未接入 `index.ts`**。
- **下一个任务：T-S2-04【P0】LLM 适配层 + 基础工具调用**（正式实现 LLMGateway / ChatProvider / ReplaceTextTool→ChangeSet / ToolRegistry / ContextBuilder 并接入主进程）。
- 再往后：T-S2-05（ChangeSet 持久化 + diff 预览 + 信任交互 UI）。
