export type {
  ChatCompletion,
  ChatMessage,
  ChatRequest,
  LlmToolCall,
  ToolSchema
} from '@shared/agent'

import type { ChatCompletion, ChatRequest } from '@shared/agent'

export interface ChatProvider {
  readonly id: string
  chat(req: ChatRequest): Promise<ChatCompletion>
}

export interface UsageRecord {
  provider: string
  tokensIn: number
  tokensOut: number
  calls: number
  costUsd: number
}
