import { describe, expect, it } from 'vitest'
import { createReplaceTextTool } from './replace-text-tool'
import type { ChangeSet, ToolExecuteContext } from '@shared/agent'

// ReplaceTextTool 单元测试：冻结契约的核心承诺——
// 工具只产出 pending ChangeSet 供用户确认（不静默改文件），
// 错误路径走可恢复的 discarded ChangeSet，绝不抛异常给 Agent 循环。

const paragraphs: Record<number, string> = {
  0: '营收增长缓慢，需要改进。',
  1: '第二段：展望积极。'
}

const tool = createReplaceTextTool(
  (documentId, index) => (documentId === 'doc-1' ? paragraphs[index] : undefined)
)

function ctx(documentId?: string): ToolExecuteContext {
  return {
    requestId: 'req-test',
    ...(documentId !== undefined ? { documentId } : {})
  }
}

function input(index: number, find: string, replacement: string) {
  return { location: { type: 'paragraph' as const, index }, find, replacement }
}

describe('replaceText tool', () => {
  it('命中替换：返回 pending ChangeSet（含 before/after 原文对照）', async () => {
    const cs = await tool.execute(input(0, '缓慢', '强劲'), ctx('doc-1'))

    expect(cs.toolName).toBe('replaceText')
    expect(cs.status).toBe('pending')
    expect(cs.error).toBeUndefined()
    expect(cs.changes).toHaveLength(1)

    const change = cs.changes[0]
    expect(change.kind).toBe('text')
    expect(change.location).toEqual({ type: 'paragraph', index: 0 })
    expect(change.before?.text).toBe('营收增长缓慢，需要改进。')
    expect(change.after?.text).toBe('营收增长强劲，需要改进。')
    expect(change.renderHint).toBe('inline')
  })

  it('同段多处出现：全部替换（split/join 语义，非仅第一处）', async () => {
    const multi = createReplaceTextTool(() => 'aXbXc')
    const cs = await multi.execute(input(0, 'X', 'Y'), ctx('doc-1'))

    expect(cs.status).toBe('pending')
    expect(cs.changes[0].after?.text).toBe('aYbYc')
  })

  it('段落越界：discarded + LOCATION_NOT_FOUND（可恢复，可让模型带上下文重试）', async () => {
    const cs = await tool.execute(input(9, 'a', 'b'), ctx('doc-1'))

    expect(cs.status).toBe('discarded')
    expect(cs.changes).toHaveLength(0)
    expect(cs.error?.code).toBe('LOCATION_NOT_FOUND')
    expect(cs.error?.recoverable).toBe(true)
  })

  it('段落内无目标文本：discarded + TEXT_NOT_FOUND（携带可读原因）', async () => {
    const cs = await tool.execute(input(0, '不存在', '新文本'), ctx('doc-1'))

    expect(cs.status).toBe('discarded')
    expect(cs.error?.code).toBe('TEXT_NOT_FOUND')
    expect(cs.error?.message).toContain('不存在')
    expect(cs.error?.recoverable).toBe(true)
  })

  it('documentId 未绑定（undefined）：按无法定位处理，不猜测', async () => {
    const cs = await tool.execute(input(0, '缓慢', '强劲'), ctx())

    expect(cs.status).toBe('discarded')
    expect(cs.error?.code).toBe('LOCATION_NOT_FOUND')
  })

  it('contextHint 声明 paragraph-exact 策略（§3.3 覆盖点接线）', () => {
    expect(tool.contextHint?.strategy).toBe('paragraph-exact')
  })

  it('validate：合法 text 变更通过', () => {
    const good: ChangeSet = {
      id: 'cs-1',
      toolName: 'replaceText',
      status: 'pending',
      changes: [
        {
          id: 'c-1',
          location: { type: 'paragraph', index: 0 },
          kind: 'text',
          before: { text: 'a' },
          after: { text: 'b' },
          renderHint: 'inline'
        }
      ],
      createdAt: new Date().toISOString()
    }

    expect(tool.validate?.(good)).toEqual({ ok: true })
  })

  it('validate：非 text 变更 + 缺 after 文本 → 逐条 issue', () => {
    const bad: ChangeSet = {
      id: 'cs-2',
      toolName: 'replaceText',
      status: 'pending',
      changes: [
        {
          id: 'c-2',
          location: { type: 'paragraph', index: 0 },
          kind: 'style',
          before: { text: 'a' },
          renderHint: 'inline'
        }
      ],
      createdAt: new Date().toISOString()
    }

    const result = tool.validate?.(bad)
    expect(result?.ok).toBe(false)
    expect(result?.issues).toHaveLength(2)
    expect(result?.issues).toContain('非法变更类型：style')
    expect(result?.issues).toContain('缺少替换后文本')
  })
})
