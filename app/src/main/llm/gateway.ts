import type { ChatProvider } from './types'
import type { UsageRecord } from './types'
import type { ChatRequest, ChatCompletion } from '@shared/agent'
import { UsageMeter } from './usage-meter'
import { createLogger } from '../logger'

const log = createLogger('llm-gateway')

export interface LlmGatewayOptions {
  maxRetries?: number
  timeoutMs?: number
  // 外部注入的共享计量器：多个 Gateway（未来多 Provider 并存）可汇总到同一份账本。
  usage?: UsageMeter
}

// LlmGateway（架构 §3.5）：Provider 之上的统一策略层——重试、超时、用量计量。
// 它不理解任何具体协议（OpenAI/Anthropic 差异都留在 Provider 内），
// Agent 只认识 Gateway，这就是"适配层"的边界。
export class LlmGateway {
  private provider: ChatProvider
  private options: { maxRetries: number; timeoutMs: number }
  private usage: UsageMeter

  constructor(provider: ChatProvider, options: LlmGatewayOptions = {}) {
    this.provider = provider
    this.options = {
      maxRetries: options.maxRetries ?? 2,
      timeoutMs: options.timeoutMs ?? 30_000
    }
    this.usage = options.usage ?? new UsageMeter(provider.id)
  }

  get providerId(): string {
    return this.provider.id
  }

  getUsage(): UsageRecord {
    return this.usage.getUsage()
  }

  // onToken：流式透传（T-S2-06 的 IPC 流式管道将挂在此处）。
  // 已知取舍：流中途失败重试时，token 会重复下发，由未来的 UI 层按消息 id 去重；
  // 本层不缓存重排（保持 Provider→Gateway→UI 的单向流简单性）。
  async chat(
    req: ChatRequest,
    opts: { onToken?: (token: string) => void } = {}
  ): Promise<ChatCompletion> {
    let lastErr: unknown
    for (let attempt = 0; attempt <= this.options.maxRetries; attempt += 1) {
      try {
        const result = await this.withTimeout(this.provider.chat(req, { onToken: opts.onToken }))
        this.usage.observe(req, result)
        log.info(
          {
            event: 'llm-chat',
            provider: this.provider.id,
            attempt,
            messageCount: req.messages.length,
            toolCallCount: result.toolCalls.length
          },
          'llm chat completed'
        )
        return result
      } catch (err) {
        lastErr = err
        log.warn(
          { event: 'llm-chat-retry', provider: this.provider.id, attempt },
          'llm chat attempt failed'
        )
      }
    }
    log.error(
      { event: 'llm-chat-failed', provider: this.provider.id, retries: this.options.maxRetries },
      'llm chat exhausted retries'
    )
    throw new Error(
      `LLM 调用失败（已重试 ${this.options.maxRetries} 次）：${String(lastErr)}`
    )
  }

  private async withTimeout<T>(p: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('LLM 调用超时')),
        this.options.timeoutMs
      )
      p.then(
        (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        (e) => {
          clearTimeout(timer)
          reject(e)
        }
      )
    })
  }
}
