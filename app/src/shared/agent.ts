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
}

export interface ChatCompletion {
  content: string
  toolCalls: LlmToolCall[]
}

export interface ChatRequest {
  messages: ChatMessage[]
  tools: ToolSchema[]
}
