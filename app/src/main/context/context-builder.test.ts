import { describe, expect, it } from 'vitest'
import {
  buildContext,
  DEFAULT_CONTEXT_BUDGET,
  type DocumentParagraph
} from './context-builder'

// ContextBuilder 单元测试：S2 质量门禁「ContextBuilder 不发送完整文件内容」
// 的可断言化——选段、钉住、双层预算（每段上限 / 总量上限）与审计元数据。

function paras(...texts: string[]): DocumentParagraph[] {
  return texts.map((text, index) => ({ index, text }))
}

describe('buildContext（隐私红线 + 双层预算）', () => {
  it('按查询词相关性选段：只发命中段落', () => {
    const built = buildContext('苹果', paras('苹果香蕉', '猫狗猪', '苹果梨'))

    expect(built.selected).toEqual([0, 2])
    expect(built.block).toContain('[段落0] 苹果香蕉')
    expect(built.block).toContain('[段落2] 苹果梨')
    expect(built.block).not.toContain('猫狗猪')
    expect(built.omittedCount).toBe(1)
  })

  it('无任何命中：回退文档开头 K 段，回退同样受预算约束', () => {
    const built = buildContext(
      'zzzqqq',
      paras(...Array.from({ length: 8 }, (_, i) => `第${i}段`))
    )

    expect(built.selected).toEqual([0, 1, 2, 3, 4, 5])
    expect(built.omittedCount).toBe(2)
    expect(built.truncated).toBe(false)
  })

  it('hint.pinnedIndexes 钉住目标段落（§3.3 覆盖点），仍占预算名额', () => {
    const built = buildContext(
      '苹果',
      paras('普通段落', '目标段落', '苹果一', '苹果二', '苹果三', '苹果四', '苹果五', '苹果六'),
      { pinnedIndexes: [1] }
    )

    // 钉住段优先占 1 个名额，剩余 5 个给打分 top-K（苹果一~苹果五）
    expect(built.selected).toEqual([1, 2, 3, 4, 5, 6])
    expect(built.block).toContain('目标段落')
    expect(built.block).not.toContain('普通段落')
    expect(built.block).not.toContain('苹果六')
  })

  it('单段超长：截断到 maxParagraphChars 并打截断标记', () => {
    const long = '长'.repeat(600)
    const built = buildContext('长', paras(long))

    expect(built.truncated).toBe(true)
    expect(built.block).toContain(`[段落0] ${'长'.repeat(500)}……[段落已截断，原文 600 字]`)
    expect(built.block).not.toContain('长'.repeat(501))
  })

  it('总量预算：加不下的段落整段放弃（不做半段裁切）', () => {
    const p = '内容'.repeat(200) // 每段 400 字 → 每行约 406 字
    const built = buildContext('内容', paras(...Array.from({ length: 8 }, () => p)))

    // 2000 字总量只装得下 4 段（第 5 段会超到 ~2030 字）
    expect(built.selected).toEqual([0, 1, 2, 3])
    expect(built.omittedCount).toBe(4)
    expect(built.truncated).toBe(true)
    expect(built.sentChars).toBeLessThanOrEqual(DEFAULT_CONTEXT_BUDGET.maxTotalChars)
  })

  it('空文档：审计元数据归零，块仅含上下文标题', () => {
    const built = buildContext('苹果', [])

    expect(built.selected).toEqual([])
    expect(built.omittedCount).toBe(0)
    expect(built.totalDocChars).toBe(0)
    expect(built.sentChars).toBeGreaterThan(0)
    expect(built.block).toContain('【文档上下文')
  })

  it('大文档审计：sentChars 有界且远小于 totalDocChars（红线可断言）', () => {
    const docs = paras(
      ...Array.from({ length: 50 }, (_, i) => `第${i}段：${'正文'.repeat(20)}`)
    )

    const built = buildContext('第10段', docs)

    const total = docs.reduce((n, d) => n + d.text.length, 0)
    expect(built.totalDocChars).toBe(total)
    expect(built.selected.length).toBeLessThanOrEqual(DEFAULT_CONTEXT_BUDGET.maxParagraphs)
    expect(built.selected).toContain(10)
    expect(built.sentChars).toBeLessThanOrEqual(DEFAULT_CONTEXT_BUDGET.maxTotalChars)
    expect(built.sentChars).toBeLessThan(built.totalDocChars)
    expect(built.omittedCount).toBe(50 - built.selected.length)
    expect(built.block.match(/\[段落\d+\]/g)).toHaveLength(built.selected.length)
  })
})
