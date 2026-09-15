import { Agent } from './agent'
import type { AgentRunResult } from './agent'
import { DocumentSessionError } from './document-session'
import type { DocumentSession } from './document-session'
import type { LlmGateway } from '../llm/gateway'
import type { ToolRegistry } from '../tools/registry'
import { buildContext } from '../context/context-builder'
import type { DocumentParagraph } from '../context/context-builder'
import type { ChatContextSummary, ChatTurnResult } from '@shared/ipc'
import type { UsageRecord } from '@shared/agent'
import { createLogger } from '../logger'

const log = createLogger('agent-service')

// AgentService（T-S2-04 编排核心，架构 §3.1 编排层的主进程侧落点）。
//
// 一轮对话 = 载文档（DocumentSession）→ 建上下文（ContextBuilder，隐私红线
// 的执行点）→ Agent 循环（Function Calling）→ 结构化 ChatTurnResult。
//
// 设计意图（勿删）：
// - 错误不抛出：任何主流程异常一律降级为 ok:false + error.code 的结构化
//   结果（§3.1 IPC 错误规范化）——渲染层永远拿到可判型的响应，不需要
//   try/catch 去试探未知形态。Agent 层的工具级异常已在 Agent 内部
//   降级为错误 ChangeSet，这里的兜底只覆盖"文档加载失败 / LLM 链路失败"。
// - 用量按轮结算：Gateway 的 UsageMeter 是进程级累计账本，此处取本轮
//   前后差值，避免把其他文件/轮次的用量记到本轮头上。
// - contextHint（§3.3 覆盖点）在此首次接线：replaceText 声明的
//   "按段落精确操作"提示传给 buildContext，决定哪些段落进上下文。

export interface AgentTurnParams {
  fileId: string
  prompt: string
  onToken?: (token: string) => void
}

export interface AgentServiceDeps {
  gateway: LlmGateway
  registry: ToolRegistry
  session: DocumentSession
}

function emptyContextSummary(): ChatContextSummary {
  return { selected: [], omittedCount: 0, truncated: false, sentChars: 0, totalDocChars: 0 }
}

function zeroUsage(provider: string): UsageRecord {
  return { provider, tokensIn: 0, tokensOut: 0, calls: 0, costUsd: 0 }
}

export class AgentService {
  private deps: AgentServiceDeps
  private agent: Agent

  constructor(deps: AgentServiceDeps) {
    this.deps = deps
    this.agent = new Agent(deps.gateway, deps.registry)
  }

  async runTurn(params: AgentTurnParams): Promise<ChatTurnResult> {
    let paragraphs: DocumentParagraph[]
    try {
      paragraphs = (await this.deps.session.loadDocument(params.fileId)).paragraphs
    } catch (err) {
      const code = err instanceof DocumentSessionError ? err.code : 'DOCUMENT_LOAD_FAILED'
      const message = err instanceof Error ? err.message : String(err)
      log.warn({ event: 'chat-turn-doc-error', fileId: params.fileId, code }, 'document load failed')
      return this.failure(code, message)
    }

    // 隐私红线执行点：不管文档多大，进入 prompt 的只有预算内的段落节选，
    // built 自带审计元数据，随 ChatTurnResult.context 一并给到渲染层可断言。
    const hint = this.deps.registry.get('replaceText')?.contextHint
    const built = buildContext(params.prompt, paragraphs, hint)

    const usageBefore = this.deps.gateway.getUsage()
    let run: AgentRunResult
    try {
      run = await this.agent.run(`${params.prompt}\n\n${built.block}`, {
        documentId: params.fileId,
        onToken: params.onToken
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error({ event: 'chat-turn-llm-failed', fileId: params.fileId }, 'agent run failed')
      // 文档已成功载入且上下文已构建，随错误一并返回审计数据，方便定位问题。
      return this.failure('LLM_CALL_FAILED', message, {
        selected: built.selected,
        omittedCount: built.omittedCount,
        truncated: built.truncated,
        sentChars: built.sentChars,
        totalDocChars: built.totalDocChars
      })
    }

    const usageAfter = this.deps.gateway.getUsage()
    return {
      ok: true,
      changeSets: run.changeSets,
      finalMessage: run.finalMessage,
      interceptions: run.interceptions,
      context: {
        selected: built.selected,
        omittedCount: built.omittedCount,
        truncated: built.truncated,
        sentChars: built.sentChars,
        totalDocChars: built.totalDocChars
      },
      usage: {
        provider: usageAfter.provider,
        tokensIn: usageAfter.tokensIn - usageBefore.tokensIn,
        tokensOut: usageAfter.tokensOut - usageBefore.tokensOut,
        calls: usageAfter.calls - usageBefore.calls,
        costUsd: usageAfter.costUsd - usageBefore.costUsd
      }
    }
  }

  private failure(
    code: string,
    message: string,
    context: ChatContextSummary = emptyContextSummary()
  ): ChatTurnResult {
    return {
      ok: false,
      error: { code, message },
      changeSets: [],
      finalMessage: '',
      interceptions: [],
      context,
      usage: zeroUsage(this.deps.gateway.providerId)
    }
  }
}
