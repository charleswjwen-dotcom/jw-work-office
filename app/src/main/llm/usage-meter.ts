import type { ChatCompletion, ChatRequest } from '@shared/agent'
import type { UsageRecord } from './types'

// UsageMeter（架构 §3.5：记录 tokensIn/out、次数、成本 → UsageRecord）。
//
// 计量策略——「精确优先，估算兜底」：
// 1. Provider 在响应中上报了 usage（OpenAI 流式需 stream_options.include_usage），
//    直接采用精确值；
// 2. 未上报（Mock、部分兼容端点）时用启发式估算：CJK 字符 ≈ 1 token/字，
//    其余字符 ≈ 4 字符/token。CJK 系数取 1 是**保守高估**（主流 tokenizer 实测约
//    0.6–0.8 token/汉字），用于成本意识场景宁可高报不可漏报。
//
// costUsd 恒为 0：单价表依赖模型/计费配置，属 T-S2-07（设置与密钥管理）范围，
// 在此之前不编造成本数字（诚实标注原则）。
export class UsageMeter {
  private record: UsageRecord

  constructor(providerId: string) {
    this.record = {
      provider: providerId,
      tokensIn: 0,
      tokensOut: 0,
      calls: 0,
      costUsd: 0
    }
  }

  // 一次成功调用的计量入口。由 LlmGateway 在每次成功返回后调用。
  observe(req: ChatRequest, res: ChatCompletion): void {
    this.record.calls += 1
    if (res.usage) {
      this.record.tokensIn += res.usage.tokensIn
      this.record.tokensOut += res.usage.tokensOut
      return
    }
    const promptText = req.messages.map((m) => m.content).join('\n')
    this.record.tokensIn += estimateTokens(promptText)
    this.record.tokensOut += estimateTokens(res.content)
  }

  getUsage(): UsageRecord {
    return { ...this.record }
  }

  reset(): void {
    this.record = {
      provider: this.record.provider,
      tokensIn: 0,
      tokensOut: 0,
      calls: 0,
      costUsd: 0
    }
  }
}

export function estimateTokens(text: string): number {
  const cjk = text.match(/[\u4e00-\u9fff]/g)?.length ?? 0
  const rest = text.length - cjk
  return cjk + Math.ceil(rest / 4)
}
