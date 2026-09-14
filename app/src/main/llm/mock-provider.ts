import type {
  ChatCompletion,
  ChatProvider,
  ChatRequest,
  LlmToolCall
} from './types'

export interface MockScenario {
  match: (req: ChatRequest) => boolean
  respond: (req: ChatRequest) => ChatCompletion
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

  async chat(req: ChatRequest): Promise<ChatCompletion> {
    for (const s of this.scenarios) {
      if (s.match(req)) return s.respond(req)
    }
    return { content: '（Mock）未匹配到可执行的意图。', toolCalls: [] }
  }
}
