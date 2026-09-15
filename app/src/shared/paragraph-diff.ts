import type { AtomicChange } from './agent'

// 段落级 diff 计算（T-S2-06，架构 §3.7「计算/渲染分离」的计算侧）。
// 算法移植自 T-S0-04 PoC（poc/s0-04-word-diff/diff_engine.js，24/24 用例验证）。
//
// 设计意图（勿删）：
// - 与渲染侧（renderer 的 inline-diff.diffWords，词级）刻意两级粒度：
//   段落级 diff 决定"哪些段被替换/插入/删除"，是回溯预览与反向 ChangeSet 的
//   唯一事实源；词级 diff 只在渲染单段内部着色。计算是纯函数、无 IO、不
//   import Electron，可同时运行于主进程（回溯路径）与 vitest（属性测试）。
// - 索引统一锚定 before 序列（LocationSelector.paragraph.index）：所有
//   delete/insert/text 的 location.index 都是 before 段落号；apply 端按锚点
//   分组、从后往前 splice，一次遍历内互不干扰（PoC 结论 ②）。
// - AtomicChange 无 order 字段：数组位置即应用顺序（PoC 的 order 计数器语义
//   由"产出顺序天然单调"承载）。
// - 回滚语义（PoC 结论 ③）：不做机械反演，反向重新 diff——
//   computeParagraphDiff(after, before) 即回滚变更集，天然保证对称正确。

export function computeParagraphDiff(
  beforeParas: string[],
  afterParas: string[]
): AtomicChange[] {
  const n = beforeParas.length
  const m = afterParas.length

  // LCS 长度表：dp[i][j] = beforeParas[i..] 与 afterParas[j..] 的最长公共子序列长度。
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    Array.from({ length: m + 1 }, () => 0)
  )
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (beforeParas[i] === afterParas[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1])
      }
    }
  }

  const changes: AtomicChange[] = []
  let i = 0
  let j = 0
  let seq = 0
  const nextId = (): string => `ac-${String(++seq).padStart(3, '0')}`

  const pushDelete = (anchor: number): void => {
    changes.push({
      id: nextId(),
      location: { type: 'paragraph', index: anchor },
      kind: 'delete',
      before: { text: beforeParas[i] },
      renderHint: 'inline'
    })
    i++
  }
  const pushInsert = (anchor: number): void => {
    changes.push({
      id: nextId(),
      location: { type: 'paragraph', index: anchor },
      kind: 'insert',
      after: { text: afterParas[j] },
      renderHint: 'inline'
    })
    j++
  }

  // 回溯构造：优先删 before 侧（dp[i+1][j] 不劣时），随后在 dp 允许时连发插入，
  // 使同锚点的 delete+insert 相邻——这正是 coalesceReplacements 合并为 text
  // 替换的前提。
  while (i < n && j < m) {
    if (beforeParas[i] === afterParas[j]) {
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      const anchor = i
      pushDelete(anchor)
      // 边界（回归）：delete 恰好消耗最后一个 before 段（i===n）时，剩余 after
      // 侧只能全是插入——直接落在同一锚点。否则 insert 会掉进尾部循环拿到锚点
      // n，末段替换退化为 delete+insert 两条、无法被 coalesce 合并为 text。
      // （i<n 时读 dp[i+1][j] / beforeParas[i] 才在安全区间，故先短路。）
      while (
        j < m &&
        (i >= n || (beforeParas[i] !== afterParas[j] && dp[i + 1][j] < dp[i][j + 1]))
      ) {
        pushInsert(anchor)
      }
    } else {
      pushInsert(i)
    }
  }
  while (i < n) pushDelete(i)
  while (j < m) pushInsert(i)

  return coalesceReplacements(changes)
}

// 相邻 delete+insert 且锚点相同 → 合并为一条 text 替换（before/after 齐备），
// 渲染侧按"段内词级 diff"呈现。反向 ChangeSet 因此与 replaceText 工具产出的
// ChangeSet 形态完全一致，可复用同一套卡片渲染。
function coalesceReplacements(changes: AtomicChange[]): AtomicChange[] {
  const result: AtomicChange[] = []
  for (let k = 0; k < changes.length; k++) {
    const cur = changes[k]
    const nxt = changes[k + 1]
    if (
      cur &&
      nxt &&
      cur.kind === 'delete' &&
      nxt.kind === 'insert' &&
      cur.location.type === 'paragraph' &&
      nxt.location.type === 'paragraph' &&
      cur.location.index === nxt.location.index
    ) {
      result.push({
        id: cur.id,
        location: cur.location,
        kind: 'text',
        before: cur.before,
        after: nxt.after,
        renderHint: 'inline'
      })
      k++
    } else if (cur) {
      result.push(cur)
    }
  }
  return result
}

// apply 端（PoC applyChanges 的移植）：把 diff 结果重放到 before 序列得到 after
// 序列。主要用于测试的往返性质验证（apply(before, diff(before, after)) === after）；
// 生产写文件走 word.applyParagraphEdits（带段级对齐防线），回溯走整文件原子
// 替换（file.copy），均不经过本函数。
export function applyParagraphDiff(beforeParas: string[], changes: AtomicChange[]): string[] {
  // 按锚点分组（组内保持产出顺序 = 应用顺序），锚点从后往前处理——
  // splice 高位先行不扰动低位索引（PoC 结论 ②）。
  const byIndex = new Map<number, AtomicChange[]>()
  for (const op of changes) {
    if (op.location.type !== 'paragraph') continue
    const group = byIndex.get(op.location.index)
    if (group) group.push(op)
    else byIndex.set(op.location.index, [op])
  }

  const out = beforeParas.slice()
  const sortedIndices = Array.from(byIndex.keys()).sort((a, b) => b - a)
  for (const idx of sortedIndices) {
    const group = byIndex.get(idx) ?? []
    const textOp = group.find((c) => c.kind === 'text')
    const deleteOp = group.find((c) => c.kind === 'delete' || c.kind === 'text')
    const inserts = group.filter((c) => c.kind === 'insert')
    if (textOp?.after?.text !== undefined) {
      const extras = inserts.map((c) => c.after?.text ?? '')
      out.splice(idx, 1, textOp.after.text, ...extras)
    } else if (deleteOp) {
      out.splice(idx, 1, ...inserts.map((c) => c.after?.text ?? ''))
    } else {
      out.splice(idx, 0, ...inserts.map((c) => c.after?.text ?? ''))
    }
  }
  return out
}
