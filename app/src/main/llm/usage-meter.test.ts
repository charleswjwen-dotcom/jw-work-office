import { describe, expect, it } from 'vitest'
import { UsageMeter, estimateTokens } from './usage-meter'
import type { ChatCompletion, ChatRequest } from '@shared/agent'

// 单元测试：UsageMeter「精确优先，估算兜底」计量策略（架构 §3.5）。
// costUsd 在 T-S2-07 接入价目表前必须诚实为 0——显式断言，防止未来"顺手"编造成本。

function req(messageContents: string[]): ChatRequest {
  return {
    messages: messageContents.map((content) => ({ role: 'user' as const, content })),
    tools: []
  }
}

function completion(usage?: ChatCompletion['usage']): ChatCompletion {
  return { content: '回答内容', toolCalls: [], ...(usage !== undefined ? { usage } : {}) }
}

describe('estimateTokens（估算兜底：CJK 1 token/字，其余 4 字符/token）', () => {
  it('空串为 0', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('纯 CJK 按字数计', () => {
    expect(estimateTokens('你好')).toBe(2)
  })

  it('纯西文按 4 字符/token 向上取整', () => {
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
  })

  it('混合文本 = CJK 字数 + 非CJK字符数÷4 向上取整', () => {
    expect(estimateTokens('你好abcd')).toBe(3)
  })
})

describe('UsageMeter', () => {
  it('Provider 上报 usage 时采用精确值并累计次数', () => {
    const meter = new UsageMeter('openai-compatible:test')
    meter.observe(req(['第一问']), completion({ tokensIn: 10, tokensOut: 4 }))
    meter.observe(req(['第二问']), completion({ tokensIn: 3, tokensOut: 2 }))

    expect(meter.getUsage()).toEqual({
      provider: 'openai-compatible:test',
      tokensIn: 13,
      tokensOut: 6,
      calls: 2,
      costUsd: 0
    })
  })

  it('未上报 usage 时回退启发式估算（CJK 逐字计）', () => {
    const meter = new UsageMeter('mock')
    meter.observe(req(['你好世界']), completion())

    const usage = meter.getUsage()
    expect(usage.tokensIn).toBe(4)
    expect(usage.tokensOut).toBe(4) // “回答内容”为 4 个 CJK 字
    expect(usage.calls).toBe(1)
  })

  it('reset 清零但保留 provider 身份', () => {
    const meter = new UsageMeter('mock')
    meter.observe(req(['你好世界']), completion())
    meter.reset()

    expect(meter.getUsage()).toEqual({
      provider: 'mock',
      tokensIn: 0,
      tokensOut: 0,
      calls: 0,
      costUsd: 0
    })
  })

  it('costUsd 在接入价目表（T-S2-07）前诚实为 0', () => {
    const meter = new UsageMeter('mock')
    meter.observe(req(['你好世界']), completion({ tokensIn: 100, tokensOut: 100 }))
    expect(meter.getUsage().costUsd).toBe(0)
  })
})
