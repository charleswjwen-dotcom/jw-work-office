import { OpenAICompatibleProvider } from './openai-provider'
import { MockChatProvider } from './mock-provider'
import type { ChatProvider } from './types'
import type { ModelConfigRecord } from '../../shared/db-protocol'
import { createLogger } from '../logger'

const log = createLogger('provider-factory')

// Provider 解析优先级链（T-S2-07 定稿形态，架构 §3.5/§3.6）：
// 1. env 三元组（MWO_LLM_BASE_URL/API_KEY/MODEL）——CI/开发期覆盖入口，
//    优先级最高（保证既有工作流与 e2e 不受设置存储影响）；
// 2. DB 默认模型配置 + KeyStore 主进程解密（密钥的正式归宿）；
// 3. MockChatProvider 诚实降级——密钥解密失败/配置不完整/无配置时
//    明示原因回退，绝不假装已连上模型。
//
// store 端口由主进程注入（makeProviderStore）：启动装配与配置变更后的
// refreshProvider 共用同一端口，保证两条路径的优先级链完全一致。
export interface ResolvedChatProvider {
  provider: ChatProvider
  mode: 'openai-compatible' | 'mock'
  note?: string
}

// 解析默认配置的最小依赖（端口式，测试可注入假实现）：
// decryptKey 返回 null = 密钥缺失或解密失败（如 OS keychain 重置），
// 按链降级 Mock 并在 note 中说明。
export interface ProviderStorePort {
  getDefaultConfig(): Promise<ModelConfigRecord | null>
  decryptKey(ref: string): string | null
}

export async function resolveChatProvider(
  store?: ProviderStorePort
): Promise<ResolvedChatProvider> {
  const baseUrl = process.env.MWO_LLM_BASE_URL
  const apiKey = process.env.MWO_LLM_API_KEY
  const model = process.env.MWO_LLM_MODEL

  if (baseUrl && apiKey && model) {
    log.info(
      { event: 'provider-resolved', mode: 'openai-compatible', model, source: 'env' },
      'llm provider ready'
    )
    return {
      provider: new OpenAICompatibleProvider({ baseUrl, apiKey, model }),
      mode: 'openai-compatible'
    }
  }

  // T-S2-07：env 缺失时读 DB 默认配置（密钥只在主进程解密，不经过渲染层/日志）。
  if (store) {
    const config = await store.getDefaultConfig().catch(() => null)
    if (config) {
      const key = config.apiKeyRef ? store.decryptKey(config.apiKeyRef) : null
      if (config.baseUrl && config.model && key) {
        log.info(
          { event: 'provider-resolved', mode: 'openai-compatible', model: config.model, source: 'store' },
          'llm provider ready'
        )
        return {
          provider: new OpenAICompatibleProvider({
            baseUrl: config.baseUrl,
            apiKey: key,
            model: config.model
          }),
          mode: 'openai-compatible'
        }
      }
      const missing = [
        !config.baseUrl && 'baseUrl',
        !config.model && 'model',
        !key && 'API Key（未设置或解密失败）'
      ].filter(Boolean)
      const note = `默认模型配置「${config.name}」不完整（缺 ${missing.join('/')}），回退 Mock Provider——仅可用于链路验证`
      log.warn({ event: 'provider-resolved', mode: 'mock', source: 'store', missing }, note)
      return { provider: new MockChatProvider(), mode: 'mock', note }
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
