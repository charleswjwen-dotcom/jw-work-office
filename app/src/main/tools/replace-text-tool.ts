import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import type {
  AtomicChange,
  ChangeSet,
  Tool,
  ToolExecuteContext,
  ValidationResult
} from '@shared/agent'

const locationSchema = z.object({
  type: z.literal('paragraph'),
  index: z.number()
})

const inputSchema = z.object({
  location: locationSchema.describe('目标段落定位'),
  find: z.string().describe('要查找的原文本'),
  replacement: z.string().describe('替换后的新文本')
})

type ReplaceTextInput = z.infer<typeof inputSchema>

// 段落解析器：按 (documentId, paragraphIndex) 取当前段落文本。
// 之所以带 documentId 而非闭包捕获某个文件：Tool 在应用级 Registry 注册一次，
// 但每轮对话的目标文件不同——冻结契约的 ToolExecuteContext.documentId
// （@shared/agent.ts）正是为这个"每次执行时绑定目标文档"场景预留的。
export type ParagraphResolver = (
  documentId: string | undefined,
  index: number
) => string | undefined

export function createReplaceTextTool(resolveParagraph: ParagraphResolver): Tool {
  return {
    name: 'replaceText',
    description:
      '在指定段落中把 find 文本替换为 replacement 文本，输出 ChangeSet 供用户确认，不直接修改文件。',
    category: 'deterministic',
    isDestructive: false,
    preview: true,
    // contextHint（§3.3 覆盖点）：告诉 ContextBuilder"本工具按段落 index 精确操作"，
    // 请把候选段落（尤其含待替换文本的段落）钉进上下文。字段本身是冻结接口的
    // 可选项，这里首次给出实际取值，语义见 context-builder.ts。
    contextHint: {
      strategy: 'paragraph-exact',
      note: '按 LocationSelector.paragraph 精确操作，候选段落应整体进入上下文'
    },
    inputSchema,
    async execute(input: ReplaceTextInput, ctx: ToolExecuteContext): Promise<ChangeSet> {
      const original = resolveParagraph(ctx.documentId, input.location.index)
      if (original === undefined) {
        return {
          id: randomUUID(),
          toolName: 'replaceText',
          status: 'discarded',
          changes: [],
          error: {
            code: 'LOCATION_NOT_FOUND',
            message: `未找到段落 index=${input.location.index}`,
            recoverable: true
          },
          createdAt: new Date().toISOString()
        }
      }
      if (!original.includes(input.find)) {
        return {
          id: randomUUID(),
          toolName: 'replaceText',
          status: 'discarded',
          changes: [],
          error: {
            code: 'TEXT_NOT_FOUND',
            message: `段落中未找到待替换文本："${input.find}"`,
            recoverable: true
          },
          createdAt: new Date().toISOString()
        }
      }
      const after = original.split(input.find).join(input.replacement)
      const change: AtomicChange = {
        id: randomUUID(),
        location: input.location,
        kind: 'text',
        before: { text: original },
        after: { text: after },
        renderHint: 'inline'
      }
      ctx.logger?.('replaceText 生成 ChangeSet（未落盘）', {
        requestId: ctx.requestId,
        location: input.location
      })
      return {
        id: randomUUID(),
        toolName: 'replaceText',
        status: 'pending',
        changes: [change],
        createdAt: new Date().toISOString()
      }
    },
    validate(cs: ChangeSet): ValidationResult {
      const issues: string[] = []
      for (const c of cs.changes) {
        if (c.kind !== 'text') issues.push(`非法变更类型：${c.kind}`)
        if (c.after?.text === undefined) issues.push('缺少替换后文本')
      }
      return { ok: issues.length === 0, issues: issues.length ? issues : undefined }
    }
  }
}
