export type {
  ChatCompletion,
  ChatMessage,
  ChatRequest,
  LlmToolCall,
  ToolSchema,
  UsageRecord
} from '@shared/agent'

import type { ChatCompletion, ChatRequest } from '@shared/agent'

// 流式回调（§3.5「统一能力：流式」）：
// Provider 在流式响应中每收到一个 content 增量就调用一次 onToken。
// 注意：onToken 只透传"文本增量"；工具调用的拼装对上层透明，
// 上层永远拿到聚合完成的 ChatCompletion（Agent 循环无需理解 SSE）。
export interface ChatStreamOptions {
  onToken?: (token: string) => void
}

export interface ChatProvider {
  readonly id: string
  chat(req: ChatRequest, opts?: ChatStreamOptions): Promise<ChatCompletion>
}
