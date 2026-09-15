import JSZip from 'jszip'
import { atomicWriteFileSync } from '../db/atomic-write'
import { parseWordFile, readFileBytes } from './word-parser'
import type {
  WordApplyParagraphEditsResult,
  WordParagraphEdit
} from '../../shared/file-protocol'

// Word 段落级写入器（架构 §3.4 确定性改写之 OOXML 直改路径，T-S2-05）。
//
// 职责边界说明：
// - mammoth 只能抽取（读），不能无损写回。本模块负责"确认后写文件"：
//   JSZip 解包 docx → 定位 word/document.xml 目标 <w:p> → 保留段落结构
//   （w:pPr 段落属性 + 首个 run 的 w:rPr 字符属性）→ 单 run 重写正文 →
//   重打包 → atomicWriteFileSync（写 .tmp → fsync → rename，架构 §5）。
// - 本模块**不得 import 任何 Electron API**：与 word-parser 相同，必须能在
//   纯 Node 环境（vitest）与文件引擎 Utility 进程内同时运行。
//
// 段落号对齐（安全核心）：
// - 解析侧（mammoth extractRawText）与 splitParagraphs 的口径是"非空段从 0
//   计数"。写入器给 document.xml 的 <w:p> 建立同一口径的序号：块内抽取全部
//   <w:t> 文本、trim 后非空才占一个段落号。空段（含自闭合 <w:p/>）跳过计数，
//   与解析侧过滤行为一致。
// - 已知口径差异：mammoth 会把 <w:tab/> 渲染为 \t、<w:br/> 渲染为换行，而本
//   模块的文本抽取只拼 <w:t> 内容。这类段落会被 expectedBefore 对齐校验拦下
//   （WORD_ALIGN_MISMATCH，可读原因、绝不静默错位），属诚实降级而非数据风险。

// 段落块扫描：匹配 <w:p>...</w:p>（含带属性的 <w:p w:rsidR="...">）与自闭合 <w:p/>。
// 不会误吃 <w:pPr>/<w:pict>：后随的是字母而非空白或 ">"，正则不成立。
// [^>]* 在回溯下的性能可控：document.xml 中属性不含 ">"，实际为线性扫描。
const PARAGRAPH_BLOCK_RE = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>|<w:p\/>/g

// 块内文本抽取：拼合所有 <w:t>（含带属性的 <w:t xml:space="preserve">）内容。
const TEXT_NODE_RE = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g

// 首 run 定位：<w:r> 或 <w:r w:rsidR="...">。不会误吃 <w:rPr>（后随字母）。
const RUN_BLOCK_RE = /<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/
const PPR_BLOCK_RE = /<w:pPr>[\s\S]*?<\/w:pPr>/
const RPR_BLOCK_RE = /<w:rPr>[\s\S]*?<\/w:rPr>/
// 自闭合 <w:r/>（无内容 run）不参与 rPr 提取，直接跳过。

function unescapeXmlEntities(s: string): string {
  // &amp; 必须最后反转义，否则 "&amp;lt;" 会被二次解码为 "<"。
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function escapeXmlText(s: string): string {
  // 文本节点转义：& < > 必须转；" ' 在文本节点合法，不必转（与 make-docx 口径一致）。
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

interface ParagraphBlock {
  // 在 document.xml 字符串中的绝对区间 [start, end)，用于倒序替换。
  start: number
  end: number
  // 原开标签（保留其上的 w:rsidR 等属性）。
  openTag: string
  // 开标签与 </w:p> 之间的内部内容。
  inner: string
  // 抽取并反转义后的段落纯文本（与 mammoth 口径对齐用）。
  text: string
}

function scanParagraphBlocks(xml: string): ParagraphBlock[] {
  const blocks: ParagraphBlock[] = []
  for (const match of xml.matchAll(PARAGRAPH_BLOCK_RE)) {
    const raw = match[0]
    const start = match.index
    if (raw.endsWith('/>')) {
      // 自闭合空段：无文本、不占段落号。
      blocks.push({ start, end: start + raw.length, openTag: raw, inner: '', text: '' })
      continue
    }
    const openTag = /^<w:p(?:\s[^>]*)?>/.exec(raw)?.[0] ?? '<w:p>'
    const inner = raw.slice(openTag.length, raw.length - '</w:p>'.length)
    let text = ''
    for (const t of inner.matchAll(TEXT_NODE_RE)) {
      text += t[1]
    }
    blocks.push({
      start,
      end: start + raw.length,
      openTag,
      inner,
      text: unescapeXmlEntities(text)
    })
  }
  return blocks
}

// 重构段落块：保留 w:pPr 与首个 run 的 w:rPr，正文压缩为单 run 整段替换。
// 其余 runs（含多余 <w:t>、<w:proofErr/> 等编辑噪声）随之清除——这是
// "整段替换"的预期语义（AtomicChange.after.text 是替换后的整段全文）。
function rebuildBlock(block: ParagraphBlock, newText: string): string {
  const pPr = PPR_BLOCK_RE.exec(block.inner)?.[0] ?? ''
  const firstRun = RUN_BLOCK_RE.exec(block.inner)?.[0] ?? ''
  const rPr = RPR_BLOCK_RE.exec(firstRun)?.[0] ?? ''
  const escaped = escapeXmlText(newText)
  const run =
    rPr.length > 0
      ? `<w:r>${rPr}<w:t xml:space="preserve">${escaped}</w:t></w:r>`
      : `<w:r><w:t xml:space="preserve">${escaped}</w:t></w:r>`
  return `${block.openTag}${pPr}${run}</w:p>`
}

export async function applyParagraphEdits(
  sourcePath: string,
  edits: WordParagraphEdit[]
): Promise<WordApplyParagraphEditsResult> {
  if (edits.length === 0) {
    throw new Error('WORD_EDITS_EMPTY: 未提供任何编辑项')
  }
  const seen = new Set<number>()
  for (const edit of edits) {
    if (seen.has(edit.index)) {
      throw new Error(`WORD_EDIT_CONFLICT: 段落 ${edit.index} 出现多个编辑项`)
    }
    seen.add(edit.index)
  }

  const buf = await readFileBytes(sourcePath)
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(buf)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(`WORD_DOCX_LOAD_FAILED: ${reason}`, { cause: err })
  }
  const entry = zip.file('word/document.xml')
  if (!entry) {
    throw new Error('WORD_ENTRY_NOT_FOUND: docx 内缺少 word/document.xml')
  }
  const xml = await entry.async('string')

  // 按解析侧口径（splitParagraphs：非空段从 0 计数）建立可编辑段落表。
  const nonEmpty = scanParagraphBlocks(xml).filter((b) => b.text.trim().length > 0)

  const replacements: { start: number; end: number; replacement: string }[] = []
  for (const edit of edits) {
    const block = nonEmpty[edit.index]
    if (!block) {
      throw new Error(
        `LOCATION_NOT_FOUND: 段落 ${edit.index} 不存在（文档共 ${nonEmpty.length} 个非空段）`
      )
    }
    if (edit.expectedBefore !== undefined && edit.expectedBefore !== block.text) {
      throw new Error(
        `WORD_ALIGN_MISMATCH: 段落 ${edit.index} 当前文本与编辑基线不一致（文件可能已被外部修改）`
      )
    }
    replacements.push({
      start: block.start,
      end: block.end,
      replacement: rebuildBlock(block, edit.text)
    })
  }

  // 倒序替换避免前面的改写使后面的绝对位置失效。
  replacements.sort((a, b) => b.start - a.start)
  let out = xml
  for (const r of replacements) {
    out = out.slice(0, r.start) + r.replacement + out.slice(r.end)
  }

  zip.file('word/document.xml', out)
  const newBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  atomicWriteFileSync(sourcePath, newBuf)

  // 写后重解析：以解析器为唯一事实源返回新 contentHash（架构 §2A.6 基线一致性），
  // 同时验证写入产物仍是合法 docx（若重打包损坏，此处抛 WORD_PARSE_FAILED 而非静默）。
  const parsed = await parseWordFile(sourcePath)
  return {
    contentHash: parsed.contentHash,
    paragraphCount: parsed.meta.paragraphCount,
    byteSize: newBuf.length,
    modifiedAt: new Date().toISOString()
  }
}
