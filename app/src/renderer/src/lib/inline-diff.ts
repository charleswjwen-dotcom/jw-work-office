// 词级内联 diff（T-S2-05 渲染层纯函数库）。
// 依据 T-S0-04 PoC 结论与架构 §3.7：Word 正文 diff 用「词级 LCS」而非字符级——
// CJK 无空格须逐字比较才可见改动粒度；西文按词切分保持单词完整；
// 空白与标点各自成组，两类文字混排均可得到可读的增删高亮。
// 纯函数、零依赖：node 测试环境（无 jsdom）可直接单测（勿删此定位）。

export type DiffSegmentType = 'equal' | 'del' | 'add'

export interface DiffSegment {
  type: DiffSegmentType
  text: string
}

// 四类 token 覆盖全部字符：CJK 单字 / 字母数字连词 / 空白组 / 其余符号组（含全角标点）。
const TOKEN_RE = /[\u4e00-\u9fff]|[A-Za-z0-9]+|\s+|[^\sA-Za-z0-9\u4e00-\u9fff]+/g

export function tokenize(text: string): string[] {
  if (!text) return []
  return text.match(TOKEN_RE) ?? []
}

// DP 单元上限：超过即降级为整段 del+add，避免超长段落 O(n·m) 阻塞渲染线程。
// 降级只损失粒度不损失正确性（40_000 ≈ 200 词 × 200 词，覆盖绝大多数正文段落）。
const MAX_DP_CELLS = 40_000

export function diffWords(before: string, after: string): DiffSegment[] {
  if (before === after) return before ? [{ type: 'equal', text: before }] : []

  const a = tokenize(before)
  const b = tokenize(after)

  if (a.length * b.length > MAX_DP_CELLS) {
    const segs: DiffSegment[] = []
    if (before) segs.push({ type: 'del', text: before })
    if (after) segs.push({ type: 'add', text: after })
    return segs
  }

  // dp[i][j] = a[i..] 与 b[j..] 的 LCS 长度（自底向上，与 PoC diff_engine 同构）。
  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  // 回溯输出：相等发 equal；不等时删优先（视觉上先划掉旧词、再补新词），
  // 相邻同类型 token 合并为一个段，避免渲染碎片。
  const out: DiffSegment[] = []
  let type: DiffSegmentType | null = null
  let buf = ''
  const flush = (): void => {
    if (type && buf) out.push({ type, text: buf })
    buf = ''
  }
  const push = (t: DiffSegmentType, text: string): void => {
    if (t !== type) {
      flush()
      type = t
    }
    buf += text
  }

  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push('equal', a[i])
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push('del', a[i])
      i++
    } else {
      push('add', b[j])
      j++
    }
  }
  while (i < n) {
    push('del', a[i])
    i++
  }
  while (j < m) {
    push('add', b[j])
    j++
  }
  flush()
  return out
}
