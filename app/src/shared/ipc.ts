import type { FileRecord } from './db-protocol'

// 渲染进程可调用的白名单 API（preload 通过 contextBridge 暴露）。
// 渲染层禁止直接碰 Node/文件系统/密钥（架构 §2 安全红线），
// 所有主进程能力都必须经此显式声明的窄接口。

export interface ImportedFileSummary {
  file: FileRecord
  wordCount: number
  heading: string | null
}

export interface ImportInvokeResult {
  // 用户在对话框取消时 canceled=true，files 为空——UI 据此不报错。
  canceled: boolean
  imported: ImportedFileSummary[]
  // 单个文件导入失败不阻断整批，失败项汇总于此（对齐 PRD F1-1「失败有明确原因提示」）。
  failures: { path: string; reason: string }[]
}

export interface SearchInvokeHit {
  fileId: string
  snippet: string
  rank: number
}

export interface IpcApi {
  ping: () => Promise<string>
  // 打开系统文件选择框并导入所选 Word 文件，返回导入结果汇总。
  importWord: () => Promise<ImportInvokeResult>
  // 列出某工作区下已导入文件（默认工作区见主进程常量）。
  listFiles: (workspaceId?: string) => Promise<FileRecord[]>
  // FTS5 全文检索。
  searchFiles: (query: string) => Promise<SearchInvokeHit[]>
}
