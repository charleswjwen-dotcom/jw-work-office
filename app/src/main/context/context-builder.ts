import type { ContextHint } from '@shared/agent'

// ContextBuilder 基础实现（架构 §3.1「组装上下文」+ 隐私红线）。
//
// 设计意图（勿删）：
// - **红线**：发给 LLM 的永远只是"按查询相关性挑出的段落节选"，且受双层硬预算
//   （每段上限 + 总量上限）约束——不管文档多大，出网内容有界。这是 S2 质量门禁
//   "ContextBuilder 不发送完整文件内容"的执行点。
// - **contextHint 覆盖点**（§3.3 Tool.contextHint）：工具可声明"我需要哪些段落进
//   上下文"。T-S2-04 只落地 hint.pinnedIndexes（钉住目标段落，仍受预算约束），
//   hint.strategy 等扩展形态留作后续覆盖策略的演进位——覆盖点预留而非全量实现。
// - **选段策略**：默认按"查询词 × 段落"词面重叠打分取 top-K；无命中时回退文档
//   开头 K 段（LLM 对文档开场的理解通常最关键）。中文查询无空格分词，用字符
//   bigram 做匹配单元——朴素但零依赖，且对"替换/查找"类任务足够准。
// - 输出携带审计元数据（selected/omitted/sentChars/totalDocChars），让
//   "未发全文"在 UI 与测试里可断言、可观测，而不是一句口头承诺。

export interface DocumentParagraph {
  index: number
  text: string
}

export interface ContextBudget {
  maxParagraphs: number
  maxParagraphChars: number
  maxTotalChars: number
}

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  maxParagraphs: 6,
  maxParagraphChars: 500,
  maxTotalChars: 2000
}

export interface BuiltDocumentContext {
  // 拼装好的上下文文本块（追加到用户消息后发送）。
  block: string
  selected: number[]
  omittedCount: number
  truncated: boolean
  sentChars: number
  totalDocChars: number
}

function extractTerms(query: string): string[] {
  const terms = new Set<string>()
  // 西文按词切。
  for (const word of query.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []) {
    terms.add(word)
  }
  // CJK 无空格：滑出 bigram（含单字收尾，保证单字关键词也能命中）。
  const cjkRuns = query.match(/[\u4e00-\u9fff]+/g) ?? []
  for (const run of cjkRuns) {
    if (run.length === 1) {
      terms.add(run)
      continue
    }
    for (let i = 0; i < run.length - 1; i += 1) {
      terms.add(run.slice(i, i + 2))
    }
  }
  return Array.from(terms)
}

function scoreParagraph(text: string, terms: string[]): number {
  let score = 0
  const lower = text.toLowerCase()
  for (const term of terms) {
    let from = 0
    for (;;) {
      const at = lower.indexOf(term, from)
      if (at < 0) break
      score += 1
      from = at + term.length
    }
  }
  return score
}

function truncateParagraph(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false }
  return {
    text: `${text.slice(0, maxChars)}……[段落已截断，原文 ${text.length} 字]`,
    truncated: true
  }
}

export function buildContext(
  query: string,
  paragraphs: DocumentParagraph[],
  hint?: ContextHint,
  budget: ContextBudget = DEFAULT_CONTEXT_BUDGET
): BuiltDocumentContext {
  const totalDocChars = paragraphs.reduce((n, p) => n + p.text.length, 0)
  const totalDocCharsSafe = Number.isFinite(totalDocChars) ? totalDocChars : 0

  // 选段：hint 钉住的段落优先，剩余名额给打分 top-K。
  const pinned = new Set<number>()
  if (hint && Array.isArray(hint.pinnedIndexes)) {
    for (const idx of hint.pinnedIndexes) {
      if (typeof idx === 'number') pinned.add(idx)
    }
  }
  const terms = extractTerms(query)
  const scored = paragraphs
    .map((p) => ({ p, score: scoreParagraph(p.text, terms) }))
    .filter((x) => !pinned.has(x.p.index))
  scored.sort((a, b) => (b.score - a.score) || (a.p.index - b.p.index))

  const picked: DocumentParagraph[] = []
  for (const p of paragraphs) {
    if (pinned.has(p.index)) picked.push(p)
  }
  // 钉住段之外：有词面命中就只取命中段；全部零分（含查询为空）回退"文档开头"
  // ——见类头注释。回退也只受同一预算约束，不会因回退而放大发送量。
  const anyScored = scored.some((x) => x.score > 0)
  for (const x of scored) {
    if (picked.length >= budget.maxParagraphs) break
    if (x.score > 0 || !anyScored) picked.push(x.p)
  }
  picked.sort((a, b) => a.index - b.index)

  // 拼装 + 双层预算执行。
  const lines: string[] = ['【文档上下文（系统自动节选，非全文）】']
  let truncated = false
  let sentChars = 0
  const selected: number[] = []
  let stoppedForBudget = false
  for (const p of picked) {
    if (selected.length >= budget.maxParagraphs) {
      stoppedForBudget = true
      break
    }
    const t = truncateParagraph(p.text, budget.maxParagraphChars)
    if (t.truncated) truncated = true
    const line = `[段落${p.index}] ${t.text}`
    // 总量预算：加不下就整段放弃（不做半段裁切，保证段落语义完整可回放）。
    if (sentChars + line.length > budget.maxTotalChars) {
      truncated = true
      stoppedForBudget = true
      break
    }
    lines.push(line)
    selected.push(p.index)
    sentChars += line.length
  }
  const omittedCount = paragraphs.length - selected.length
  if (omittedCount > 0) {
    lines.push(`（另有 ${omittedCount} 个段落因预算未包含，可让助手定位后重试）`)
  }

  const block = lines.join('\n')
  return {
    block,
    selected,
    omittedCount,
    truncated: truncated || stoppedForBudget,
    sentChars: block.length,
    totalDocChars: totalDocCharsSafe
  }
}
