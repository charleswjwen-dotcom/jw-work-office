import type {
  ChatCompletion,
  ChatMessage,
  ChatRequest,
  LlmToolCall,
  ToolSchema
} from '@shared/agent'
import type { ChatProvider, ChatStreamOptions } from './types'

// OpenAI 兼容 ChatProvider（架构 §3.5）。
//
// 设计意图（勿删）：
// - **协议归一化**：中性 ChatRequest/ChatMessage 与 OpenAI 报文的全部差异
//   （assistant.tool_calls 回放、tool.tool_call_id、tools 包装、JSON 参数序列化）
//   都在本文件内屏蔽；Agent 层只面向中性接口，未来接 Anthropic/Ollama 时新增
//   Provider 即可，不改 Agent。
// - **流式实现**：始终 stream:true。content 增量经 onToken 透传；工具调用在
//   OpenAI 流里被拆成按 index 的参数分片，这里负责拼装 + JSON.parse，上层拿到
//   的永远是聚合完成的 toolCalls。
// - **可注入 fetch**：fetchImpl 参数让单测可以在无网络/无密钥环境下用本地
//   假 SSE 流验证协议正确性（测试不 mock 模块、只替传输层，保真度最高）。
// - **不在此层做重试/超时**：那是 LlmGateway 的职责（§3.5 统一能力分层）。

export interface OpenAIProviderConfig {
  baseUrl: string
  apiKey: string
  model: string
  // 请求超时由 Gateway 统一控制；此处仅保留注入点供测试替身使用。
  fetchImpl?: typeof fetch
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>

interface OpenAIStreamDelta {
  choices?: Array<{
    delta?: {
      content?: string | null
      tool_calls?: Array<{
        index?: number
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

interface AssembledToolCall {
  id: string
  name: string
  argumentFragments: string[]
}

function toOpenAIMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  return messages.map((m) => {
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: m.content,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.arguments) }
        }))
      }
    }
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.toolCallId, content: m.content }
    }
    return { role: m.role, content: m.content }
  })
}

function toOpenAITools(tools: ToolSchema[]): Record<string, unknown>[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters }
  }))
}

function finalizeToolCalls(assembled: Map<number, AssembledToolCall>): LlmToolCall[] {
  const calls: LlmToolCall[] = []
  for (const key of Array.from(assembled.keys()).sort((a, b) => a - b)) {
    const c = assembled.get(key)
    if (!c || !c.name) continue
    let args: Record<string, unknown>
    try {
      args = JSON.parse(c.argumentFragments.join('')) as Record<string, unknown>
    } catch {
      // 参数 JSON 非法（模型输出劣化）时不抛错：置空对象让 Agent 侧 zod 校验
      // 产出 INVALID_INPUT 错误 ChangeSet 回灌给模型重试，属可恢复路径。
      args = {}
    }
    calls.push({ id: c.id, name: c.name, arguments: args })
  }
  return calls
}

export class OpenAICompatibleProvider implements ChatProvider {
  readonly id: string
  private config: Required<Pick<OpenAIProviderConfig, 'baseUrl' | 'apiKey' | 'model'>>
  private doFetch: FetchLike

  constructor(config: OpenAIProviderConfig) {
    this.config = {
      baseUrl: config.baseUrl.replace(/\/+$/, ''),
      apiKey: config.apiKey,
      model: config.model
    }
    this.doFetch = (config.fetchImpl ?? fetch) as FetchLike
    this.id = `openai-compatible:${this.config.model}`
  }

  async chat(req: ChatRequest, opts: ChatStreamOptions = {}): Promise<ChatCompletion> {
    const body = {
      model: this.config.model,
      messages: toOpenAIMessages(req.messages),
      ...(req.tools.length > 0 ? { tools: toOpenAITools(req.tools) } : {}),
      stream: true,
      // 让兼容端点在最后一个 chunk 附带精确 usage（不支持的端点会被忽略，
      // UsageMeter 自然回退估算——两端都不炸）。
      stream_options: { include_usage: true }
    }

    const res = await this.doFetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.config.apiKey}`
      },
      body: JSON.stringify(body)
    })

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '')
      throw new Error(`OPENAI_HTTP_${res.status}: ${detail.slice(0, 300)}`)
    }

    let content = ''
    const assembled = new Map<number, AssembledToolCall>()
    let usage: ChatCompletion['usage']

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // SSE 以空行分帧；此处逐帧消费，容忍 chunk 边界把一条 data 切开的情况。
      let sep: number
      while ((sep = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        this.consumeFrame(frame, {
          onToken: opts.onToken,
          onContent: (t) => {
            content += t
          },
          assembled,
          setUsage: (u) => {
            usage = u
          }
        })
      }
    }

    return {
      content,
      toolCalls: finalizeToolCalls(assembled),
      ...(usage ? { usage } : {})
    }
  }

  private consumeFrame(
    frame: string,
    sink: {
      onToken?: (token: string) => void
      onContent: (token: string) => void
      assembled: Map<number, AssembledToolCall>
      setUsage: (u: ChatCompletion['usage']) => void
    }
  ): void {
    for (const line of frame.split('\n')) {
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '' || payload === '[DONE]') continue
      let delta: OpenAIStreamDelta
      try {
        delta = JSON.parse(payload) as OpenAIStreamDelta
      } catch {
        continue
      }
      if (delta.usage) {
        sink.setUsage({
          tokensIn: delta.usage.prompt_tokens ?? 0,
          tokensOut: delta.usage.completion_tokens ?? 0
        })
      }
      const choice = delta.choices?.[0]?.delta
      if (!choice) continue
      if (typeof choice.content === 'string' && choice.content.length > 0) {
        sink.onContent(choice.content)
        sink.onToken?.(choice.content)
      }
      for (const tc of choice.tool_calls ?? []) {
        const idx = tc.index ?? 0
        const slot = sink.assembled.get(idx) ?? { id: '', name: '', argumentFragments: [] }
        if (tc.id) slot.id = tc.id
        if (tc.function?.name) slot.name += tc.function.name
        if (tc.function?.arguments) slot.argumentFragments.push(tc.function.arguments)
        sink.assembled.set(idx, slot)
      }
    }
  }
}
