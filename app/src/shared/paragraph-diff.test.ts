import { describe, expect, it } from 'vitest'
import { applyParagraphDiff, computeParagraphDiff } from './paragraph-diff'

// T-S2-06：段落 diff 计算单测（PoC 移植的回归防线）。
// 核心性质：① 产出形态（kind/锚点/coalesce）；② 往返性质
// apply(before, diff(before, after)) === after；③ 反向性质（PoC 结论 ③：
// 回滚 = 反向重新 diff）。
describe('computeParagraphDiff', () => {
  it('内容一致时产出空变更集', () => {
    const paras = ['第一段', '第二段', '第三段']
    expect(computeParagraphDiff(paras, [...paras])).toEqual([])
  })

  it('单段替换合并为一条 text 变更（coalesce）', () => {
    const before = ['甲', '乙', '丙']
    const after = ['甲', '乙（改）', '丙']
    const changes = computeParagraphDiff(before, after)
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({
      location: { type: 'paragraph', index: 1 },
      kind: 'text',
      before: { text: '乙' },
      after: { text: '乙（改）' },
      renderHint: 'inline'
    })
  })

  it('末段替换同样合并为一条 text 变更（回归：insert 不得掉进尾部循环）', () => {
    const before = ['甲', '乙', '丙']
    const after = ['甲', '乙', '丙（改）']
    const changes = computeParagraphDiff(before, after)
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({
      location: { type: 'paragraph', index: 2 },
      kind: 'text',
      before: { text: '丙' },
      after: { text: '丙（改）' }
    })
  })

  it('末段替换+追加：text 与 insert 同锚点共存，重放正确', () => {
    const before = ['甲', '乙']
    const after = ['甲', '丙', '丁']
    const changes = computeParagraphDiff(before, after)
    expect(changes.map((c) => c.kind)).toEqual(['text', 'insert'])
    expect(
      changes.map((c) => (c.location.type === 'paragraph' ? c.location.index : -1))
    ).toEqual([1, 1])
    expect(applyParagraphDiff(before, changes)).toEqual(after)
  })

  it('段落插入产出 insert 变更并锚定插入位置', () => {
    const before = ['甲', '丙']
    const after = ['甲', '乙', '丙']
    const changes = computeParagraphDiff(before, after)
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({
      kind: 'insert',
      location: { type: 'paragraph', index: 1 },
      after: { text: '乙' }
    })
  })

  it('段落删除产出 delete 变更', () => {
    const before = ['甲', '乙', '丙']
    const after = ['甲', '丙']
    const changes = computeParagraphDiff(before, after)
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({
      kind: 'delete',
      location: { type: 'paragraph', index: 1 },
      before: { text: '乙' }
    })
  })

  it('尾部追加锚定在 before 序列末尾（index = n）', () => {
    const before = ['甲', '乙']
    const after = ['甲', '乙', '丙', '丁']
    const changes = computeParagraphDiff(before, after)
    expect(changes.map((c) => c.kind)).toEqual(['insert', 'insert'])
    expect(changes.map((c) => c.location)).toEqual([
      { type: 'paragraph', index: 2 },
      { type: 'paragraph', index: 2 }
    ])
  })

  it('混合修改只产出 text/insert/delete 三种 kind 且 id 唯一', () => {
    const before = ['一', '二', '三', '四', '五']
    const after = ['一', '二（改）', '四', '五', '六']
    const changes = computeParagraphDiff(before, after)
    expect(changes.length).toBeGreaterThan(0)
    const ids = new Set(changes.map((c) => c.id))
    expect(ids.size).toBe(changes.length)
    for (const c of changes) {
      expect(['text', 'insert', 'delete']).toContain(c.kind)
      expect(c.renderHint).toBe('inline')
      expect(c.id).toMatch(/^ac-\d{3}$/)
    }
  })

  it('apply 往返性质：diff 后重放必然还原 after（多组样本）', () => {
    const samples: [string[], string[]][] = [
      [[], []],
      [['a'], []],
      [[], ['a']],
      [['a', 'b'], ['a', 'b']],
      [['a', 'b'], ['a', 'c']],
      [['a'], ['b']],
      [['a', 'b'], ['a', 'c', 'd']],
      [['a', 'b'], ['c']],
      [['a', 'b', 'c'], ['c', 'b', 'a']],
      [['a', 'b', 'c', 'd'], ['a', 'x', 'y', 'd', 'e']],
      [['同', '段', '落'], ['同', '不同的段落', '落']],
      [['1', '2', '3', '4', '5'], ['2', '4']],
      [
        ['前言', '背景介绍', '方案概述', '实施计划', '风险预案', '结语'],
        ['前言', '背景（修订版）', '方案概述', '实施计划', '结语', '附录A', '附录B']
      ]
    ]
    for (const [before, after] of samples) {
      expect(applyParagraphDiff(before, computeParagraphDiff(before, after))).toEqual(after)
    }
  })

  it('反向性质：回滚 = 反向重新 diff（PoC 结论 ③）', () => {
    const before = ['甲', '乙', '丙', '丁']
    const after = ['甲', '乙（改）', '丁', '新段']
    const forward = computeParagraphDiff(before, after)
    const backward = computeParagraphDiff(after, before)
    expect(applyParagraphDiff(before, forward)).toEqual(after)
    expect(applyParagraphDiff(after, backward)).toEqual(before)
  })
})
