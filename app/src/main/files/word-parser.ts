import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import mammoth from 'mammoth'
import type { WordParseResult } from '../../shared/file-protocol'

// Word 解析（架构 §3.4 双轨之"快路径"）。
//
// 职责边界说明：
// - 架构 §3.4 把 mammoth 定位为"转 HTML 预览"，确定性改写走 docx/OOXML。
//   本模块用 mammoth 的 extractRawText 走**纯文本抽取**路径，服务于两件事：
//   ① FTS5 全文索引（T-S2-03 验收："FTS5 可按关键词检索到导入文件"）
//   ② content_hash 基线（架构 §4/§2A.6：用于应用外编辑感知）
//   HTML 预览（mammoth.convertToHtml）留给 T-S2-08 右栏预览，互不冲突。
// - 本模块**不得 import 任何 Electron API**：它要能在纯 Node 环境（vitest）与
//   Utility 进程内同时运行，保持可测试性。
//
// 诚实标注：架构 §4 files 表无 title/wordCount 列，且 .docx 的"权威分页"需
// LibreOffice 无头转换（S2 未接入）。因此这里只产出派生元信息与正文哈希，
// 不给 page_count 编造数值（由上层置 null 并注释原因）。

function countWords(text: string): number {
  // 中文以字符近似计词，西文按空白分词——这是"字数"的近似口径，
  // 精确字数需与 Word 的计数规则（含/不含标点）对齐，属 UI 展示级精度，不影响检索与哈希。
  const cjk = text.match(/[\u4e00-\u9fff]/g)?.length ?? 0
  const latin = text
    .replace(/[\u4e00-\u9fff]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0).length
  return cjk + latin
}

// 段落切分的唯一规则源（架构 §3.4 LocationSelector.paragraph）：
// FTS5 索引、ContextBuilder 展示、ReplaceTextTool 定位三处共用同一套切法，
// 否则"模型看到的段落号"与"工具操作的段落号"会错位。T-S2-04 的
// DocumentSession 也从这里取规则，禁止各处自写正则。
export function splitParagraphs(text: string): string[] {
  return text
    .split(/\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
}

function pickFirstParagraph(text: string): { heading: string | null; paragraphCount: number } {
  const paragraphs = splitParagraphs(text)
  // 启发式标题：文档首个非空段落。这不是 .docx 的真实 Title 属性
  // （真实标题需解析 core.xml，后续可增强），仅作列表辅助展示，不参与检索语义。
  const heading = paragraphs.length > 0 ? paragraphs[0].slice(0, 120) : null
  return { heading, paragraphCount: paragraphs.length }
}

export function hashContent(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex')
}

export async function parseWordFile(sourcePath: string): Promise<WordParseResult> {
  try {
    // 不用 readFile → mammoth.convert，而是让 mammoth 读盘：
    // mammoth.convert 内部会自行打开文件，避免在内存中多存一份完整 .docx 缓冲。
    const { value } = await mammoth.extractRawText({ path: sourcePath })
    const text = value ?? ''
    const { heading, paragraphCount } = pickFirstParagraph(text)
    return {
      text,
      meta: {
        wordCount: countWords(text),
        charCount: text.length,
        heading,
        paragraphCount
      },
      contentHash: hashContent(text)
    }
  } catch (err) {
    // 统一错误语义：解析失败必须携带可读原因（PRD F1-1 DoD："导入失败有明确原因提示；不崩溃"）。
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(`WORD_PARSE_FAILED: ${reason}`, { cause: err })
  }
}

// 供测试与上层复用：仅读取原始字节（不解析），用于 size 与"文件存在性"校验。
export async function readFileBytes(sourcePath: string): Promise<Buffer> {
  return readFile(sourcePath)
}
