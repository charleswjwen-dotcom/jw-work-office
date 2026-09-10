# My-work-office

交互式桌面办公智能体（Electron + React + TypeScript）。围绕 Word / PPT / Excel 三类文档的**处理、生成、优化**，以对话式交互驱动，配合双轨文件引擎（JS 库快路径 + LibreOffice / python-pptx 保真路径）与可回滚的变更集（ChangeSet）机制。

当前处于 **S0 技术预研（PoC）阶段**，尚未进入正式产品编码。本仓库先纳入需求 / 架构 / 计划 / 任务四类治理文档与 PoC 源码。

---

## 一、文档索引（唯一事实来源）

| 文档 | 版本 | 状态 | 作用 |
| --- | --- | --- | --- |
| [需求文档.md](./需求文档.md) | PRD v2.1 | 已确认 | 产品需求、范围、验收口径 |
| [架构设计文档.md](./架构设计文档.md) | HLD v1.2 | 待评审确认 | 高层架构、进程模型、引擎选型、数据/变更模型 |
| [后续工作计划.md](./后续工作计划.md) | v1.1 | 生效 | S0–S6 阶段划分与阶段质量门禁 |
| [开发任务清单.md](./开发任务清单.md) | v1.0 | 执行中 | 可执行任务分解（T-S0-01…），开发的**主基准** |

> 开发按 `开发任务清单.md` 推进；任何实现决策以四份文档为准，代码不得偏离文档口径，若需偏离先改文档再改代码。

---

## 二、目录结构

```
.
├── 需求文档.md            # PRD v2.1
├── 架构设计文档.md         # HLD v1.2
├── 后续工作计划.md         # 阶段计划 v1.1
├── 开发任务清单.md         # 可执行任务清单 v1.0（开发主基准）
├── poc/                   # 技术预研代码，一子目录一个 PoC
│   └── s0-01-pptx/        # T-S0-01：python-pptx 打包全链路 PoC
│       ├── make_sample.py         # 生成测试用 .pptx
│       ├── poc_modify.py          # 核心改写逻辑
│       ├── verify.py              # 读回校验
│       ├── pptx_cli.py            # 统一 CLI 入口（供 Electron 调用）
│       ├── electron_poc.js        # Node child_process 调用 + 进程池预热验证
│       └── T-S0-01-结论报告.md     # PoC 结论（回写架构决策）
├── .gitignore
└── README.md              # 本文件（含工程管理规范）
```

> `poc/` 下运行产物（`sample.pptx`、`orig.png`、`modified*.pptx`、`pool_test_out/`）与打包产物（`dist/`、`build/`、`*.spec`）均由 `.gitignore` 排除，**不入库**；仅提交源码与结论报告。

---

## 三、PoC 复现（T-S0-01）

前置：Python 3.9+、Node 18+。

```bash
cd poc/s0-01-pptx
pip install python-pptx pyinstaller

# 1. 生成样例 + 改写 + 读回校验
python make_sample.py
python pptx_cli.py modify sample.pptx modified.pptx
python pptx_cli.py verify modified.pptx

# 2. 打包（务必 --onedir，勿用 --onefile）
pyinstaller --onedir --name pptx_cli_dir pptx_cli.py

# 3. Node child_process 热路径 / 进程池验证
node electron_poc.js
```

**关键结论**（详见 [结论报告](./poc/s0-01-pptx/T-S0-01-结论报告.md)）：
- 打包必须用 `--onedir`（`--onefile` 每次冷启动约 4.6s，不可接受）。
- onedir 体积约 33MB（≤100MB ✅）；热路径约 136ms（≤500ms ✅）；改写读回通过 ✅。
- 采用**进程池预热**模式对接 Electron。
- 正式 Developer ID 签名 + notarytool 公证、Windows 流程验证：延至 S2 前置补验。

---

## 四、工程管理规范

### 4.1 分支模型
- `main`：受保护主干，始终可评审/可运行，不直接在其上做长任务开发。
- 特性分支：`feat/<任务ID>-<简述>`，如 `feat/t-s0-04-word-diff`。
- 修复分支：`fix/<简述>`；文档分支：`docs/<简述>`。
- 分支合入 `main` 前需自测通过并更新对应文档状态。

### 4.2 提交信息（Conventional Commits）
格式：`<type>(<scope>): <subject>`
- `type`：`feat` / `fix` / `docs` / `refactor` / `test` / `chore` / `poc`。
- `scope`：模块或任务 ID，如 `poc-s0-01`、`docs`、`pptx-engine`。
- `subject`：中文/英文简述，祈使句、不加句号。
- 示例：`poc(s0-01): 验证 python-pptx onedir 打包与热路径`

### 4.3 版本与文档
- 四份治理文档均带版本号；每次实质修订**递增版本号**并在文档内记录变更点。
- PoC 得出的结论必须回写到对应文档（如 T-S0-01 结论 → 架构 v1.3 的 §3.4）。
- 任务状态在 `开发任务清单.md` 内用 `[ ]`/`[~]`/`[x]`/`[!]` 实时维护。

### 4.4 PoC 生命周期
- 每个 PoC 独占 `poc/<阶段>-<序号>-<主题>/` 目录。
- 开工前先在任务清单中写明**成功标准**；完成后产出 `T-xxx-结论报告.md`。
- 仅提交源码与结论；样例数据、临时输出、打包产物一律走 `.gitignore`。

### 4.5 入库红线
- 不提交密钥/凭证（`.env`、`*.pem`、`*.key`、`*.p12`、`credentials.*`）。
- 不提交构建产物、`node_modules/`、`__pycache__/`、SQLite 数据文件、日志。
- 提交前先 `git status` 核对，确认无临时产物混入。

### 4.6 质量门禁
- 每阶段结束按 `开发任务清单.md` 的阶段门禁表逐条核对，未过不进入下一阶段。
- 附录 §9.1 执行期重点关注清单与具体任务 ID 绑定，作为持续风险看板。
