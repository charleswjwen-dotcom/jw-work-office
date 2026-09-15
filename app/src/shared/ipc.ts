import type { FileRecord } from './db-protocol'
import type { AtomicChange, ChangeSet, ChangeSetStatus, UsageRecord } from './agent'

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
  // —— T-S2-05 信任交互（架构 §5）——
  // 列出当前 pending 的 ChangeSet（changes 已 resolve，含 >512KB 外置文件回读）。
  listPendingChangesets: () => Promise<ChangeSetView[]>
  // 接受（全部或部分）。acceptedChangeIds 省略 = 全部接受；
  // 传 AtomicChange.id 列表 = 部分接受（仅勾选项写入文件）。
  acceptChangeset: (id: string, acceptedChangeIds?: string[]) => Promise<TrustApplyResult>
  // 拒绝：丢弃 ChangeSet 并清理外置文件，文件内容不变。
  rejectChangeset: (id: string) => Promise<TrustRejectResult>
  // —— T-S2-06 版本历史与线性回溯（架构 §5 / PRD 3.3）——
  // 列出指定文件的版本历史（seq 降序；当前版本带 isCurrent=true）。
  listVersions: (fileId: string) => Promise<VersionView[]>
  // 预览恢复到某版本的段落级 diff（当前内容 → 快照内容）。
  getVersionDiff: (versionId: string) => Promise<VersionDiffResult>
  // 恢复到指定版本：原子替换工作文件 + 新建反向 ChangeSet + 生成回溯后快照版本。
  restoreVersion: (versionId: string) => Promise<RestoreResult>
}

// ChangeSet 的渲染视图（T-S2-05）：渲染层只拿展示所需的窄字段，不暴露
// changesPath 等存储细节。fileName 由主进程 join files 表得出。
export interface ChangeSetView {
  id: string
  fileId: string
  fileName: string
  // 触发本次修改的对话指令（卡片头部展示；M1 冻结无 toolName 列，以此近似）。
  sourceCommand: string | null
  status: 'pending'
  changes: AtomicChange[]
}

// accept 的结构化结果：成功带终态与已应用计数；失败走 error（§3.1 规范化）。
export interface TrustApplyResult {
  ok: boolean
  error?: { code: string; message: string }
  status?: ChangeSetStatus
  appliedCount?: number
  // 写入后新正文哈希（成功时必填，可用于断言基线刷新）。
  contentHash?: string
}

export interface TrustRejectResult {
  ok: boolean
  error?: { code: string; message: string }
  status?: 'discarded'
}

// —— T-S2-06 版本历史视图（PRD 3.3 / 架构 §5 线性回溯）——
// 渲染层只拿展示所需窄字段，不暴露 snapshotPath 等存储细节。
// isCurrent：该版本是否即 files.currentVersionId 指向的当前版本。
export interface VersionView {
  id: string
  fileId: string
  seq: number
  createdAt: number
  author: 'ai' | 'user' | 'external' | null
  triggerCommand: string | null
  changeSummary: string | null
  isCurrent: boolean
}

// 版本 diff 预览的结构化结果（与 TrustApplyResult 同一扁平风格）：
// changes = computeParagraphDiff(当前工作文件段落, 目标快照段落)——
// before=当前内容、after=恢复后内容，渲染语义与 ChangeSetCard 一致
// （删红=即将移除的现在，增绿=恢复回来的过去）。
export interface VersionDiffResult {
  ok: boolean
  error?: { code: string; message: string }
  versionId?: string
  seq?: number
  changes?: AtomicChange[]
}

// 回溯结果：成功带新版本 id（回溯动作自身生成的后像快照）与反向 ChangeSet id。
export interface RestoreResult {
  ok: boolean
  error?: { code: string; message: string }
  versionId?: string
  changeSetId?: string
  appliedCount?: number
  contentHash?: string
}
