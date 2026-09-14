import type { ChatProvider, UsageRecord } from './types'
import type { ChatRequest, ChatCompletion } from '@shared/agent'
import { createLogger } from '../logger'

const log = createLogger('llm-gateway')

export interface LlmGatewayOptions {
  maxRetries?: number
  timeoutMs?: number
}

export class LlmGateway {
  private provider: ChatProvider
  private options: Required<LlmGatewayOptions>
  private usage: UsageRecord

  constructor(provider: ChatProvider, options: LlmGatewayOptions = {}) {
    this.provider = provider
    this.options = {
      maxRetries: options.maxRetries ?? 2,
      timeoutMs: options.timeoutMs ?? 30_000
    }
    this.usage = {
      provider: provider.id,
      tokensIn: 0,
      tokensOut: 0,
      calls: 0,
      costUsd: 0
    }
  }

  get providerId(): string {
    return this.provider.id
  }

  getUsage(): UsageRecord {
    return { ...this.usage }
  }

  async chat(req: ChatRequest): Promise<ChatCompletion> {
    let lastErr: unknown
    for (let attempt = 0; attempt <= this.options.maxRetries; attempt += 1) {
      try {
        const result = await this.withTimeout(this.provider.chat(req))
        this.recordUsage(req, result)
        log.info(
          {
            event: 'llm-chat',
            provider: this.provider.id,
            attempt,
            messageCount: req.messages.length,
            calls: this.usage.calls,
            tokensIn: this.usage.tokensIn,
            tokensOut: this.usage.tokensOut
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

  private recordUsage(req: ChatRequest, res: ChatCompletion): void {
    this.usage.calls += 1
    this.usage.tokensIn += estimateTokens(
      req.messages.map((m) => m.content).join(' ')
    )
    this.usage.tokensOut += estimateTokens(res.content)
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

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}
