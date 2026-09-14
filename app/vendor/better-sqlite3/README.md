# vendor/better-sqlite3 —— 双 ABI 原生二进制说明

本目录存放 better-sqlite3 的预编译原生二进制副本，用于解决“同一模块需在两种不同 ABI 运行时下工作”的问题。

## 为什么需要它（架构背景）

better-sqlite3 是 C++ 原生模块，编译产物按 `NODE_MODULE_VERSION`(ABI) 与运行时绑定。
本项目存在两种运行时，ABI 不同：

- **生产运行时 = Electron 33**（内置 Node 20，`NODE_MODULE_VERSION = 130`）——DB Utility 进程在此运行。
- **单元测试运行时 = 宿主 Node**（vitest，`NODE_MODULE_VERSION` 随本机 Node，如 127/147）。

`node_modules/better-sqlite3/build/Release/better_sqlite3.node` 同一时刻只能匹配其中一个 ABI，
另一个会在 `new Database()` 处崩溃（历史现象：SIGSEGV 或 NODE_MODULE_VERSION 报错，见 T-S2-02 修复记录）。

> 备注：better-sqlite3 v13 改用 N-API 10 编译，而 Electron 33 内置 Node 20 仅提供 N-API 9，
> 运行时 `new Database()` 必段错误。因此本项目锁定 **better-sqlite3@12.11.1**（经典 NAN/V8 per-ABI 绑定），
> 由 electron-rebuild 精确匹配 Electron 的 `NODE_MODULE_VERSION=130`。

## 两份产物的用途

| 文件 | ABI | 使用者 |
| --- | --- | --- |
| `better_sqlite3.electron-abi130.node` | Electron 33 (modules=130) | 生产运行时（复制到 build/Release） |
| `better_sqlite3.node-abi.node` | 宿主 Node | vitest（经 connection.ts 的 nativeBinding 注入） |

`src/main/db/connection.ts` 的 `resolveNativeBinding()` 会在“非 Electron 的纯 Node 环境”下
把 `nativeBinding` 指向 `better_sqlite3.node-abi.node`；Electron 内则走默认解析（build/Release）。

## 升级 Electron 或 better-sqlite3 后如何刷新

```bash
# 1) 生成 Electron ABI 产物并放入 build/Release
npm run rebuild:electron
cp node_modules/better-sqlite3/build/Release/better_sqlite3.node \
   vendor/better-sqlite3/better_sqlite3.electron-abi130.node   # 文件名中的 abi 版本号按需更新

# 2) 生成宿主 Node ABI 产物副本供 vitest 使用
npm run rebuild:node
cp node_modules/better-sqlite3/build/Release/better_sqlite3.node \
   vendor/better-sqlite3/better_sqlite3.node-abi.node

# 3) 把 build/Release 恢复为 Electron ABI（生产运行时用）
cp vendor/better-sqlite3/better_sqlite3.electron-abi130.node \
   node_modules/better-sqlite3/build/Release/better_sqlite3.node
```

> 打包（electron-builder）阶段应确保 `build/Release` 为 Electron ABI，并将 better-sqlite3 标记为 asarUnpack。
