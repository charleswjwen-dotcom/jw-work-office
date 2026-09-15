import { describe, expect, it } from 'vitest'
import { diffWords, tokenize, type DiffSegment } from './inline-diff'

// T-S2-05 渲染层 diff 算法单测（node 环境，零 DOM 依赖——与库的纯函数定位一致）。
// 断言三层：
// 1. tokenize 分词口径：CJK 逐字 / 西文成词 / 空白与标点各自成组（中英混排均词级）；
// 2. diffWords 段结构与合并行为（含超限降级路径）；
// 3. 往返还原不变量：equal+del 按序拼回 before，equal+add 按序拼回 after——
//    这是 diff 正确性的底线（T-S2-05 验收「diff 渲染正确」的算法侧前提）。

function roundTrip(segments: DiffSegment[]): { before: string; after: string } {
  let before = ''
  let after = ''
  for (const seg of segments) {
    if (seg.type === 'equal') {
      before += seg.text
      after += seg.text
    } else if (seg.type === 'del') {
      before += seg.text
    } else {
      after += seg.text
    }
  }
  return { before, after }
}

// 多组中英混排用例统一跑不变量，避免逐例手算 LCS 回溯顺序的脆弱断言。
const ROUND_TRIP_CASES: [string, string][] = [
  ['公司季度报告草稿：营收增长缓慢，需要改进。', '公司季度报告草稿：营收增长强劲，需要改进。'],
  ['The quick brown fox jumps', 'The slow brown fox leaps'],
  ['版本 v1 发布', '版本 v2 发布'],
  ['开头新增了引导语，结尾保留', '结尾保留'],
  ['完全相同的一段文字', '完全相同的一段文字'],
  ['', '从无到有'],
  ['从有到无', ''],
  ['', ''],
  ['多处分隔：第一处，第二处；第三处。', '多处变更：首处，次处；末处。']
]

describe('tokenize（四类 token 覆盖全部字符）', () => {
  it('空字符串返回空数组', () => {
    expect(tokenize('')).toEqual([])
  })

  it('CJK 逐字、西文成词、空白与全角标点各自成组', () => {
    expect(tokenize('你好world ！')).toEqual(['你', '好', 'world', ' ', '！'])
  })

  it('半角标点成组、连续空白合并且不与标点粘连', () => {
    expect(tokenize('Hello, 世界！2024')).toEqual(['Hello', ',', ' ', '世', '界', '！', '2024'])
    expect(tokenize('a  b')).toEqual(['a', '  ', 'b'])
  })

  it('分词穷尽：token 拼接恒等于原文', () => {
    for (const [text] of ROUND_TRIP_CASES) {
      expect(tokenize(text).join('')).toBe(text)
    }
  })
})

describe('diffWords（词级 LCS）', () => {
  it('完全相等：单 equal 段（早退路径）', () => {
    expect(diffWords('完全相同的一段文字', '完全相同的一段文字')).toEqual([
      { type: 'equal', text: '完全相同的一段文字' }
    ])
  })

  it('双侧皆空：返回空数组', () => {
    expect(diffWords('', '')).toEqual([])
  })

  it('纯新增：单个 add 段', () => {
    expect(diffWords('', '从无到有')).toEqual([{ type: 'add', text: '从无到有' }])
  })

  it('纯删除：单个 del 段', () => {
    expect(diffWords('从有到无', '')).toEqual([{ type: 'del', text: '从有到无' }])
  })

  it('尾部追加：equal + add', () => {
    expect(diffWords('原句', '原句补充后缀')).toEqual([
      { type: 'equal', text: '原句' },
      { type: 'add', text: '补充后缀' }
    ])
  })

  it('中文替换：删优先（先划旧词再补新词），相邻 token 合并成段', () => {
    expect(
      diffWords('公司季度报告草稿：营收增长缓慢，需要改进。', '公司季度报告草稿：营收增长强劲，需要改进。')
    ).toEqual([
      { type: 'equal', text: '公司季度报告草稿：营收增长' },
      { type: 'del', text: '缓慢' },
      { type: 'add', text: '强劲' },
      { type: 'equal', text: '，需要改进。' }
    ])
  })

  it('英文替换：词级粒度（quick/slow 各成一段，不退化为整句）', () => {
    expect(diffWords('The quick brown fox', 'The slow brown fox')).toEqual([
      { type: 'equal', text: 'The ' },
      { type: 'del', text: 'quick' },
      { type: 'add', text: 'slow' },
      { type: 'equal', text: ' brown fox' }
    ])
  })

  it('中英混排同段：西文按词、中文按字', () => {
    expect(diffWords('版本 v1 发布', '版本 v2 发布')).toEqual([
      { type: 'equal', text: '版本 ' },
      { type: 'del', text: 'v1' },
      { type: 'add', text: 'v2' },
      { type: 'equal', text: ' 发布' }
    ])
  })

  it('DP 超限降级：整段 del+add（粒度变粗，正确性不变）', () => {
    const before = '甲'.repeat(250)
    const after = '乙'.repeat(250)
    const segments = diffWords(before, after)
    expect(segments).toEqual([
      { type: 'del', text: before },
      { type: 'add', text: after }
    ])
  })

  it('往返还原不变量：equal+del 拼回 before，equal+add 拼回 after', () => {
    for (const [before, after] of ROUND_TRIP_CASES) {
      const restored = roundTrip(diffWords(before, after))
      expect(restored.before).toBe(before)
      expect(restored.after).toBe(after)
    }
  })

  it('相邻同类型段不碎片化（渲染稳定性）', () => {
    const segments = diffWords('第一第二第三段', '第一第二第五段')
    const nonEqual = segments.filter((s) => s.type !== 'equal')
    expect(nonEqual).toEqual([
      { type: 'del', text: '三' },
      { type: 'add', text: '五' }
    ])
  })
})
