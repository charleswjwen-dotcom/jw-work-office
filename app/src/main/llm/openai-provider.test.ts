import { describe, expect, it } from 'vitest'
import { OpenAICompatibleProvider } from './openai-provider'
import type { ChatMessage, ToolSchema } from '@shared/agent'

// 单元测试：OpenAICompatibleProvider 协议归一化 + 流式拼装（架构 §3.5）。
// 测试不 mock 模块、只替传输层（注入返回假 SSE 流的 fetchImpl）——在无网络/
// 无密钥环境下验证报文形态与流解析的正确性（保真度最高的替身策略）。

interface RecordedCall {
  url: string
  body: Record<string, unknown>
  headers: Headers
}

function fakeFetch(respond: () => Response): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      headers: new Headers(init?.headers)
    })
    return respond()
  }
  return { fetchImpl, calls }
}

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    }
  })
  return new Response(stream, { status: 200 })
}

function deltaFrame(delta: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`
}

function usageFrame(tokensIn: number, tokensOut: number): string {
  return `data: ${JSON.stringify({
    choices: [{ delta: {} }],
    usage: { prompt_tokens: tokensIn, completion_tokens: tokensOut }
  })}\n\n`
}

const DONE = 'data: [DONE]\n\n'

function makeProvider(fetchImpl: typeof fetch): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    baseUrl: 'https://api.test/v1/',
    apiKey: 'sk-test',
    model: 'gpt-test',
    fetchImpl
  })
}

describe('OpenAICompatibleProvider（流式 + 协议归一化）', () => {
  it('聚合 content 增量、逐 token 回调 onToken、请求打到规范化后的端点', async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      sseResponse([deltaFrame({ content: '你' }), deltaFrame({ content: '好' }), DONE])
    )
    const provider = makeProvider(fetchImpl)
    const tokens: string[] = []

    const completion = await provider.chat(
      { messages: [{ role: 'user', content: '你好' }], tools: [] },
      { onToken: (t) => tokens.push(t) }
    )

    expect(completion.content).toBe('你好')
    expect(completion.toolCalls).toEqual([])
    expect(tokens).toEqual(['你', '好'])
    // 尾斜杠被规范化，端点形态正确
    expect(calls[0].url).toBe('https://api.test/v1/chat/completions')
    expect(calls[0].headers.get('authorization')).toBe('Bearer sk-test')
  })

  it('拼装按 index 分片到达的工具调用参数', async () => {
    const args = JSON.stringify({
      location: { type: 'paragraph', index: 2 },
      find: '旧文本',
      replacement: '新文本'
    })
    const half = Math.floor(args.length / 2)
    const { fetchImpl } = fakeFetch(() =>
      sseResponse([
        deltaFrame({
          tool_calls: [
            { index: 0, id: 'call-1', function: { name: 'replaceText', arguments: args.slice(0, half) } }
          ]
        }),
        deltaFrame({
          tool_calls: [{ index: 0, function: { arguments: args.slice(half) } }]
        }),
        DONE
      ])
    )
    const provider = makeProvider(fetchImpl)

    const completion = await provider.chat({ messages: [{ role: 'user', content: '替换' }], tools: [] })

    expect(completion.toolCalls).toEqual([
      {
        id: 'call-1',
        name: 'replaceText',
        arguments: {
          location: { type: 'paragraph', index: 2 },
          find: '旧文本',
          replacement: '新文本'
        }
      }
    ])
  })

  it('采用流末 chunk 上报的精确 usage（stream_options.include_usage 的响应侧）', async () => {
    const { fetchImpl } = fakeFetch(() =>
      sseResponse([deltaFrame({ content: '好的' }), usageFrame(10, 5), DONE])
    )
    const provider = makeProvider(fetchImpl)

    const completion = await provider.chat({ messages: [{ role: 'user', content: 'hi' }], tools: [] })

    expect(completion.usage).toEqual({ tokensIn: 10, tokensOut: 5 })
  })

  it('参数 JSON 非法时降级为空对象（交由 Agent 侧 zod 校验走可恢复路径）', async () => {
    const { fetchImpl } = fakeFetch(() =>
      sseResponse([
        deltaFrame({
          tool_calls: [{ index: 0, id: 'call-bad', function: { name: 'replaceText', arguments: '{not-json' } }]
        }),
        DONE
      ])
    )
    const provider = makeProvider(fetchImpl)

    const completion = await provider.chat({ messages: [{ role: 'user', content: 'x' }], tools: [] })

    expect(completion.toolCalls[0]?.arguments).toEqual({})
  })

  it('容忍 chunk 边界把一帧 data 切开', async () => {
    const frame = deltaFrame({ content: '跨块' })
    const mid = Math.floor(frame.length / 2)
    const { fetchImpl } = fakeFetch(() => sseResponse([frame.slice(0, mid), frame.slice(mid), DONE]))
    const provider = makeProvider(fetchImpl)

    const completion = await provider.chat({ messages: [{ role: 'user', content: 'x' }], tools: [] })

    expect(completion.content).toBe('跨块')
  })

  it('请求报文符合 OpenAI 形态：tool_calls 回放 / tool_call_id / tools 包装 / 流式标记', async () => {
    const { fetchImpl, calls } = fakeFetch(() => sseResponse([DONE]))
    const provider = makeProvider(fetchImpl)
    const replay: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '把A替换成B' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call-1', name: 'replaceText', arguments: { find: 'A', replacement: 'B' } }]
      },
      { role: 'tool', content: '{"status":"pending"}', toolCallId: 'call-1' }
    ]
    const tools: ToolSchema[] = [
      { name: 'replaceText', description: '替换文本', parameters: { type: 'object' } }
    ]

    await provider.chat({ messages: replay, tools })

    expect(calls).toHaveLength(1)
    const body = calls[0].body
    expect(body.model).toBe('gpt-test')
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: { name: 'replaceText', description: '替换文本', parameters: { type: 'object' } }
      }
    ])

    const messages = body.messages as Array<Record<string, unknown>>
    expect(messages).toHaveLength(4)
    // assistant 消息携带完整 toolCalls 数组（一条 assistant 对多条 tool 的前置）
    expect(messages[2]).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: {
            name: 'replaceText',
            arguments: JSON.stringify({ find: 'A', replacement: 'B' })
          }
        }
      ]
    })
    expect(messages[3]).toEqual({ role: 'tool', tool_call_id: 'call-1', content: '{"status":"pending"}' })
  })

  it('非 2xx 响应抛出携带状态码的错误', async () => {
    const { fetchImpl } = fakeFetch(() => new Response('upstream down', { status: 502 }))
    const provider = makeProvider(fetchImpl)

    await expect(provider.chat({ messages: [{ role: 'user', content: 'x' }], tools: [] })).rejects.toThrow(
      'OPENAI_HTTP_502'
    )
  })
})
