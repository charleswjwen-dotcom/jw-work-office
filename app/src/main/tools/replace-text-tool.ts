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

export function createReplaceTextTool(
  getParagraphText: (index: number) => string | undefined
): Tool<ReplaceTextInput> {
  return {
    name: 'replaceText',
    description: '在指定段落中把 find 文本替换为 replacement 文本，输出 ChangeSet 供用户确认，不直接修改文件。',
    category: 'deterministic',
    isDestructive: false,
    preview: true,
    inputSchema,
    async execute(input: ReplaceTextInput, ctx: ToolExecuteContext): Promise<ChangeSet> {
      const original = getParagraphText(input.location.index)
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
