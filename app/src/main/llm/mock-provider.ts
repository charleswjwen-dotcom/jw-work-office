import type {
  ChatCompletion,
  ChatProvider,
  ChatRequest,
  ChatStreamOptions,
  LlmToolCall
} from './types'

export interface MockScenario {
  match: (req: ChatRequest) => boolean
  respond: (req: ChatRequest) => ChatCompletion
}

// 流式模拟（T-S2-08③）：按固定小包/节拍把 content 切成增量吐给 onToken，
// 让渲染层/e2e 能断言"渐进拼接"而非一次性整段。真实 Provider 的增量
// 粒度由上游 SDK 决定；Mock 不模拟流中途失败重试（gateway 已记录该取舍，
// 由 UI 按轮清空兜底）。
const STREAM_CHUNK_SIZE = 6
const STREAM_TICK_MS = 8

async function streamContent(content: string, opts?: ChatStreamOptions): Promise<void> {
  if (!opts?.onToken || content.length === 0) return
  for (let i = 0; i < content.length; i += STREAM_CHUNK_SIZE) {
    opts.onToken(content.slice(i, i + STREAM_CHUNK_SIZE))
    await new Promise((resolve) => setTimeout(resolve, STREAM_TICK_MS))
  }
}

let toolCallSeq = 0
function nextToolCallId(): string {
  toolCallSeq += 1
  return `mock-call-${toolCallSeq}`
}

function lastUserContent(req: ChatRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i -= 1) {
    if (req.messages[i].role === 'user') return req.messages[i].content
  }
  return ''
}

function hasToolResult(req: ChatRequest): boolean {
  return req.messages.some((m) => m.role === 'tool')
}

const defaultScenarios: MockScenario[] = [
  {
    match: (req) => hasToolResult(req),
    respond: () => ({
      content: '已根据工具返回的 ChangeSet 完成处理，等待用户确认。',
      toolCalls: []
    })
  },
  {
    match: (req) => /替换|replace|改成|修改/.test(lastUserContent(req)),
    respond: (req) => {
      const text = lastUserContent(req)
      const m = text.match(/["“](.+?)["”].*?["“](.+?)["”]/)
      const find = m?.[1] ?? '旧文本'
      const replacement = m?.[2] ?? '新文本'
      const call: LlmToolCall = {
        id: nextToolCallId(),
        name: 'replaceText',
        arguments: {
          location: { type: 'paragraph', index: 0 },
          find,
          replacement
        }
      }
      return { content: '', toolCalls: [call] }
    }
  }
]

export class MockChatProvider implements ChatProvider {
  readonly id = 'mock'
  private scenarios: MockScenario[]

  constructor(scenarios?: MockScenario[]) {
    this.scenarios = [...(scenarios ?? []), ...defaultScenarios]
  }

  async chat(req: ChatRequest, opts?: ChatStreamOptions): Promise<ChatCompletion> {
    // 场景决议与流式推送解耦：任何场景（含测试注入的自定义场景）的
    // content 都统一按小包流出，返回值仍是完整 completion。
    const completion = this.resolve(req)
    await streamContent(completion.content, opts)
    return completion
  }

  private resolve(req: ChatRequest): ChatCompletion {
    for (const s of this.scenarios) {
      if (s.match(req)) return s.respond(req)
    }
    return { content: '（Mock）未匹配到可执行的意图。', toolCalls: [] }
  }
}
