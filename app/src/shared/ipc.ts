import type { FileRecord } from './db-protocol'
import type { ChangeSet, UsageRecord } from './agent'

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

// T-S2-04：对话一轮的结果。ChangeSet 只在此"过路"，落库与信任交互在 T-S2-05。
// context 字段是隐私红线的可观测证据（§3.1/S2 门禁"ContextBuilder 不发送完整文件"）：
// 渲染层与测试可据此断言"只发了节选，未发全文"。
export interface ChatContextSummary {
  // 被选入上下文的段落 index 列表。
  selected: number[]
  // 因预算被排除的段落数。
  omittedCount: number
  // 是否发生过截断（段落级或总量级）。
  truncated: boolean
  // 实际发送字符数 / 文档总字符数——两者并列即可审计"未发全文"。
  sentChars: number
  totalDocChars: number
}

export interface ChatTurnResult {
  ok: boolean
  // 结构化错误（§3.1 IPC 错误规范化）：主流程异常不 throw，统一走此字段。
  error?: { code: string; message: string }
  // 本轮产出的 ChangeSet（含 pending 与错误降级两类），未做任何落盘。
  changeSets: ChangeSet[]
  finalMessage: string
  // 系统层强制拦截记录（如工具试图跳过确认）。
  interceptions: string[]
  context: ChatContextSummary
  // 本轮用量（§3.5 UsageMeter）。网关持进程级累计账本，此处取本轮前后差值，
  // 避免把其他文件/轮次的用量记到本轮头上。
  usage: UsageRecord
}

export interface IpcApi {
  ping: () => Promise<string>
  // 打开系统文件选择框并导入所选 Word 文件，返回导入结果汇总。
  importWord: () => Promise<ImportInvokeResult>
  // 列出某工作区下已导入文件（默认工作区见主进程常量）。
  listFiles: (workspaceId?: string) => Promise<FileRecord[]>
  // FTS5 全文检索。
  searchFiles: (query: string) => Promise<SearchInvokeHit[]>
  // 对指定文件发起一轮智能体对话（T-S2-04）。
  // 流式 token 推送属 T-S2-06 流式管道，此处先落请求/响应形态。
  chatSend: (fileId: string, prompt: string) => Promise<ChatTurnResult>
}
