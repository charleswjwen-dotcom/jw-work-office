# My-work-office · 开发者引导（app/）

本目录是 Electron 应用工程本体。治理文档（PRD / 架构 / 计划 / 任务清单）在**仓库根目录**，是唯一事实来源；本文只讲「如何开发、如何再次进入项目」的工作流。协作 Agent 的强制规则见 [.trae/rules/project_rules.md](./.trae/rules/project_rules.md)。

---

## 一、技术栈与进程模型

- **Electron 33 + React 18 + TypeScript**，构建工具 `electron-vite`。
- **三进程 + 双 Utility**：主进程（IPC 编排）+ 渲染进程（React UI）+ 两个 Utility 子进程：
  - DB Utility：`better-sqlite3` + Drizzle，负责 SQLite 读写（`src/main/db/worker.ts`）。
  - File Utility：`mammoth` 等，负责文件解析等 CPU 密集任务（`src/main/files/worker.ts`）。
  - 两者**故意隔离，勿合并**（架构 §2、§3.4）。
- 数据层：SQLite + Drizzle ORM，全文检索用 FTS5（`tokenize='trigram'` 以支持中文）。

---

## 二、再次进入项目的标准流程

```bash
cd app/

# 1. 依赖（首次 / package.json 变更后）
npm install
npm run rebuild:electron    # 见「四、better-sqlite3 双 ABI」，装完/rebuild 后必做

# 2. 读任务清单，定位下一个 [ ] 任务
#    ../开发任务清单.md —— 开发主基准

# 3. 开发
npm run dev                 # 启动 Electron + Vite 热更新

# 4. 收工前跑满五道门禁（见第三节）
```

---

## 三、五道质量门禁（全绿才算完成，才进入下一任务）

```bash
npm run typecheck   # 双 tsc（node + web）
npm run lint        # eslint 严格模式
npm test            # vitest（Node 环境，当前 27 用例）
npm run build       # electron-vite 生产构建
npm run test:e2e    # playwright（Electron 冒烟 + 数据层就绪断言）
```

- 建议 e2e **连跑两次**，验证迁移幂等（历史缺陷：迁移非幂等导致二次启动数据层 NOT_READY）。
- 只标注**真正完成且有证据**的任务；有偏差要在任务清单诚实披露。严禁伪造结果。

其他常用脚本：`npm run test:watch`（监听测试）、`npm run db:generate`（Drizzle 生成迁移）、`npm run rebuild:node`（把原生模块还原为 Node ABI，一般不手动用）。

---

## 四、better-sqlite3 双 ABI（重要，勿踩坑）

版本**锁定 `better-sqlite3@12.11.1`，禁止升级到 v13**：v13 用 N-API 10，而 Electron 33 内置 Node 20 仅提供 N-API 9，`new Database()` 会直接 SIGSEGV。

原生模块采用双 ABI 共存：

| 运行时 | 使用的二进制 | ABI |
| --- | --- | --- |
| Electron（含 DB Utility 进程、e2e） | `node_modules/better-sqlite3/build/Release/better_sqlite3.node` | Electron，modules=130 |
| Node / vitest | `vendor/better-sqlite3/better_sqlite3.node-abi.node`（由 `connection.ts` 的 `resolveNativeBinding()` 注入） | Node |

约束：

- **`vendor/better-sqlite3/` 不可删**（双 ABI 产物 + 说明，是修复本体）。
- `npm install` / `npm rebuild` 后 `build/Release` 可能变回 Node ABI → 跑 Electron / e2e 前务必 `npm run rebuild:electron`。
- 遇 `NODE_MODULE_VERSION` 报错或 DB 崩溃：先 `npm run rebuild:electron`；仍异常按 [vendor/better-sqlite3/README.md](./vendor/better-sqlite3/README.md) 恢复两份产物。

---

## 五、目录速览

```
app/
├── src/main/          # 主进程
│   ├── db/            # SQLite + Drizzle 数据层（connection/worker/repositories/…）
│   ├── files/         # 文件解析 Utility（word-parser 等）
│   ├── import/        # Word 导入编排
│   ├── llm/  tools/  agent/   # T-S0-05 PoC 遗留骨架，尚未接入 index.ts（见下）
│   └── index.ts       # IPC 编排、Utility 客户端接线
├── src/preload/       # 预加载桥
├── src/renderer/      # React UI
├── src/shared/        # 主/渲染共享协议（ipc / db-protocol / file-protocol）
├── e2e/               # playwright 冒烟
├── vendor/better-sqlite3/   # 双 ABI 产物（勿删）
└── .trae/rules/       # 协作 Agent 强制规则
```

---

## 六、进度落点（截至最近一次更新）

- 已完成：S0 PoC 主体、S1 设计冻结、**T-S2-01/02/03**（工程骨架 / SQLite+Drizzle 数据层 / Word 导入全链路）。
- ⚠️ `src/main/llm`、`src/main/tools`、`src/main/agent` 为 **T-S0-05 PoC 遗留骨架，尚未接入 `index.ts`**（`index.ts` 无引用）。T-S2-04 将正式实现并接线。
- **下一个任务：T-S2-04【P0】LLM 适配层 + 基础工具调用**——实现并接入 LLMGateway / ChatProvider / UsageMeter / ReplaceTextTool（产出 ChangeSet，不静默写文件）/ ToolRegistry / ContextBuilder。
- 再往后：T-S2-05（ChangeSet 持久化 + diff 预览 + 信任交互 UI）。

---

## 七、代码约定（简版）

- 注释写**架构意图**（"为什么这样设计"），关键约束标注「勿删」并引用任务号/历史缺陷；注释用中文，标识符用英文。
- 新增前先看邻近文件的框架/命名/类型约定，不引入未在 `package.json` 声明的库。
- 数据库迁移必须**幂等**（`connection.ts` 的 `__mwo_migrations` 记账表 + 基线检测，勿破坏）。

> 完整强制规则见 [.trae/rules/project_rules.md](./.trae/rules/project_rules.md)。
