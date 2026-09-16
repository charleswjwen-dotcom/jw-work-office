import { describe, expect, it } from 'vitest'
import { MockChatProvider } from './mock-provider'
import type { ChatRequest } from './types'

// T-S2-08③ 单元测试：Mock 流式模拟——chat(req, opts) 在 opts.onToken 存在时
// 把 content 按固定小包流出（模拟真实 SDK 的增量粒度），拼接后与返回的
// completion.content 一致；无 opts / 空 content 时静默跳过（不回调不抛错）。

function userReq(content: string): ChatRequest {
  return { messages: [{ role: 'user', content }], tools: [] }
}

describe('MockChatProvider 流式模拟（T-S2-08③）', () => {
  it('onToken 渐进流出：多包且拼接等于 content', async () => {
    const provider = new MockChatProvider()
    const chunks: string[] = []

    const completion = await provider.chat(userReq('随便聊聊'), {
      onToken: (t) => chunks.push(t)
    })

    // 未匹配任何场景 → 固定 fallback 文案（>6 字符）→ 必然切成多包
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('')).toBe(completion.content)
    expect(completion.toolCalls).toEqual([])
  })

  it('工具轮 content 为空：不产生任何 token 回调', async () => {
    const provider = new MockChatProvider()
    const chunks: string[] = []

    const completion = await provider.chat(userReq('把"a"替换成"b"'), {
      onToken: (t) => chunks.push(t)
    })

    expect(completion.toolCalls).toHaveLength(1)
    expect(completion.toolCalls[0]?.name).toBe('replaceText')
    expect(chunks).toEqual([])
  })

  it('无 opts 调用：与旧形态完全一致（向后兼容）', async () => {
    const provider = new MockChatProvider()

    const completion = await provider.chat(userReq('把"a"替换成"b"'))

    expect(completion.toolCalls[0]?.name).toBe('replaceText')
    expect(completion.content).toBe('')
  })
})
