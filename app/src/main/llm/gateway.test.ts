import { describe, expect, it } from 'vitest'
import { LlmGateway } from './gateway'
import { UsageMeter } from './usage-meter'
import type { ChatCompletion, ChatProvider, ChatRequest, ChatStreamOptions } from './types'

// 单元测试：LlmGateway 统一策略层——重试、超时、用量计量（架构 §3.5）。
// 关键断言点：失败调用不计入账本（observe 仅发生在成功返回时）。

class StubProvider implements ChatProvider {
  readonly id = 'stub'
  calls = 0
  behavior: (req: ChatRequest, opts?: ChatStreamOptions) => Promise<ChatCompletion> = async () => ({
    content: 'ok',
    toolCalls: []
  })

  async chat(req: ChatRequest, opts?: ChatStreamOptions): Promise<ChatCompletion> {
    this.calls += 1
    return this.behavior(req, opts)
  }
}

const REQ: ChatRequest = { messages: [{ role: 'user', content: '你好' }], tools: [] }

describe('LlmGateway', () => {
  it('失败后重试，成功才计量', async () => {
    const provider = new StubProvider()
    let n = 0
    provider.behavior = async () => {
      n += 1
      if (n === 1) throw new Error('first attempt fails')
      return { content: 'second', toolCalls: [] }
    }
    const usage = new UsageMeter('stub')
    const gateway = new LlmGateway(provider, { usage })

    const result = await gateway.chat(REQ)

    expect(result.content).toBe('second')
    expect(provider.calls).toBe(2)
    // 失败的那次调用不计入账本
    expect(usage.getUsage().calls).toBe(1)
  })

  it('onToken 流式透传到 Provider', async () => {
    const provider = new StubProvider()
    provider.behavior = async (_req, opts) => {
      opts?.onToken?.('A')
      opts?.onToken?.('B')
      return { content: 'AB', toolCalls: [] }
    }
    const gateway = new LlmGateway(provider)
    const tokens: string[] = []

    await gateway.chat(REQ, { onToken: (t) => tokens.push(t) })

    expect(tokens).toEqual(['A', 'B'])
  })

  it('重试耗尽后抛错并说明重试次数', async () => {
    const provider = new StubProvider()
    provider.behavior = async () => {
      throw new Error('always down')
    }
    const gateway = new LlmGateway(provider, { maxRetries: 2 })

    await expect(gateway.chat(REQ)).rejects.toThrow('已重试 2 次')
    expect(provider.calls).toBe(3) // 1 次原始调用 + 2 次重试
  })

  it('超时按失败处理（受重试策略支配）', async () => {
    const provider = new StubProvider()
    provider.behavior = () => new Promise<ChatCompletion>(() => undefined)
    const gateway = new LlmGateway(provider, { maxRetries: 0, timeoutMs: 20 })

    await expect(gateway.chat(REQ)).rejects.toThrow('LLM 调用超时')
    expect(provider.calls).toBe(1)
  })

  it('providerId 透出身份；未注入账本时自建并从零开始', async () => {
    const provider = new StubProvider()
    const gateway = new LlmGateway(provider)

    expect(gateway.providerId).toBe('stub')
    expect(gateway.getUsage().calls).toBe(0)
  })
})
