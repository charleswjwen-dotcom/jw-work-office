import { OpenAICompatibleProvider } from './openai-provider'
import { MockChatProvider } from './mock-provider'
import type { ChatProvider } from './types'
import { createLogger } from '../logger'

const log = createLogger('provider-factory')

// Provider 选择（T-S2-04 阶段形态）：
// - 通过环境变量三元组接入任一 OpenAI 兼容端点（含 Ollama/vLLM 本地网关，
//   满足 §3.5"数据不出内网"场景）；
// - 三者任一缺失 → 回退 MockChatProvider，保证无密钥环境下应用与 e2e 仍可
//   跑通完整 Agent 链路（诚实降级，不假装已连上模型）。
//
// 【勿删】迁移注记：API Key 的正式归宿是 T-S2-07（safeStorage 加密 + 设置 UI，
// 架构 §3.5/§6）。届时本工厂改为读取设置存储，env 保留为 CI/开发期覆盖入口。
export interface ResolvedChatProvider {
  provider: ChatProvider
  mode: 'openai-compatible' | 'mock'
  note?: string
}

export function resolveChatProvider(): ResolvedChatProvider {
  const baseUrl = process.env.MWO_LLM_BASE_URL
  const apiKey = process.env.MWO_LLM_API_KEY
  const model = process.env.MWO_LLM_MODEL

  if (baseUrl && apiKey && model) {
    log.info({ event: 'provider-resolved', mode: 'openai-compatible', model }, 'llm provider ready')
    return {
      provider: new OpenAICompatibleProvider({ baseUrl, apiKey, model }),
      mode: 'openai-compatible'
    }
  }

  const missing = [
    !baseUrl && 'MWO_LLM_BASE_URL',
    !apiKey && 'MWO_LLM_API_KEY',
    !model && 'MWO_LLM_MODEL'
  ].filter(Boolean)
  const note = `未配置 LLM（缺 ${missing.join('/')}），回退 Mock Provider——仅可用于链路验证`
  log.warn({ event: 'provider-resolved', mode: 'mock', missing }, note)
  return { provider: new MockChatProvider(), mode: 'mock', note }
}
