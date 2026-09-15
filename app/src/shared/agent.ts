import type { ZodType } from 'zod'

export type LocationSelector =
  | { type: 'paragraph'; index: number }
  | { type: 'heading'; text: string; level?: number }
  | { type: 'wordPage'; page: number }
  | { type: 'slide'; index: number; shapeId?: string }
  | { type: 'cellRange'; sheet: string; range: string }
  | { type: 'namedRange'; name: string }

export type ChangeKind =
  | 'text'
  | 'style'
  | 'insert'
  | 'delete'
  | 'cell'
  | 'element'
  | 'image'

export type RenderHint = 'inline' | 'sideBySide' | 'thumbnail'

export interface ChangePayload {
  text?: string
  html?: string
  [key: string]: unknown
}

export interface AtomicChange {
  id: string
  location: LocationSelector
  kind: ChangeKind
  before?: ChangePayload
  after?: ChangePayload
  accepted?: boolean
  renderHint?: RenderHint
}

export type ChangeSetStatus = 'pending' | 'applied' | 'discarded' | 'partial'

export interface ChangeSet {
  id: string
  toolName: string
  status: ChangeSetStatus
  changes: AtomicChange[]
  error?: ChangeSetError
  createdAt: string
}

export interface ChangeSetError {
  code: string
  message: string
  recoverable: boolean
}

export type ToolCategory = 'deterministic' | 'semi' | 'generative'

export interface ValidationResult {
  ok: boolean
  issues?: string[]
}

export interface ToolExecuteContext {
  documentId?: string
  requestId: string
  logger?: (msg: string, meta?: Record<string, unknown>) => void
}

export interface ContextHint {
  [key: string]: unknown
}

export interface Tool<TInput = unknown> {
  name: string
  description: string
  category: ToolCategory
  isDestructive: boolean
  preview: boolean
  inputSchema: ZodType<TInput>
  contextHint?: ContextHint
  execute(input: TInput, ctx: ToolExecuteContext): Promise<ChangeSet>
  validate?(cs: ChangeSet): ValidationResult
}

export interface ToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface LlmToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCallId?: string
  // 中性协议归一化（架构 §3.5）所需的回放字段：assistant 消息在发起 tool call 后，
  // 必须能携带完整 toolCalls 列表，Provider 才能映射回 OpenAI 的
  // assistant.tool_calls / tool.tool_call_id 报文形态。Mock 等本地 Provider 忽略之。
  // 注意：M1 冻结范围仅限 Tool 接口与 LocationSelector（§3.3），
  // 此处属于 LLM 消息协议扩展，不触碰冻结基线。
  toolCalls?: LlmToolCall[]
}

export interface ChatCompletion {
  content: string
  toolCalls: LlmToolCall[]
  // Provider 上报的精确 token 用量（流式需 stream_options.include_usage）。
  // 缺失时 UsageMeter 回退到启发式估算（§3.5）。可选字段，向后兼容。
  usage?: { tokensIn: number; tokensOut: number }
}

export interface ChatRequest {
  messages: ChatMessage[]
  tools: ToolSchema[]
}

// 用量账目（架构 §3.5 UsageMeter 的产出）。放共享层的理由：渲染层需要在
// ChatTurnResult（shared/ipc.ts）里展示用量；主进程 llm/ 经 types.ts re-export，
// 全仓单一来源。costUsd 在 T-S2-07 接入价目表前诚实置 0，不编造定价。
export interface UsageRecord {
  provider: string
  tokensIn: number
  tokensOut: number
  calls: number
  costUsd: number
}
