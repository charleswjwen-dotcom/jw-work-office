import type { FileRecord } from '../../shared/db-protocol'
import type { WordParseResult } from '../../shared/file-protocol'
import type { FileClient } from '../files/client'
import type { DbClient } from '../db/client'
import { splitParagraphs } from '../files/word-parser'
import type { DocumentParagraph } from '../context/context-builder'

// DocumentSession（T-S2-04）：Agent 体系对"目标文档"的唯一视角。
//
// 设计意图（勿删）：
// - 冻结契约里 Tool 只认 (documentId, paragraphIndex)（ToolExecuteContext.documentId
//   + LocationSelector.paragraph）。本类负责把 fileId 变成"当前段落数组"：
//   files 表查记录（拿到工作区副本路径）→ 文件引擎 Utility 进程解析（word.parse，
//   §2 主进程只做调度）→ splitParagraphs 切段（与 FTS5/ContextBuilder 同源，
//   见 word-parser.ts 顶部说明，保证三处段落号一致）。
// - 缓存策略：按 fileId 缓存、以 content_hash 校验。T-S2-04 的 ChangeSet 恒为
//   pending 不落盘，段落原文在一轮内不会变——缓存命中安全；未来（T-S2-05+）
//   变更被确认写盘后 content_hash 变化，loadDocument 自动重解析，缓存不会说谎。
// - 运行于主进程，但全部解析 I/O 都走 FileClient 跨进程请求，不 import
//   mammoth——主进程保持"薄调度层"（架构 §2），也让本类在测试中可用薄替身覆盖。

export interface LoadedDocument {
  file: FileRecord
  paragraphs: DocumentParagraph[]
}

interface CacheEntry {
  contentHash: string | null
  paragraphs: DocumentParagraph[]
}

// 携带结构化 code 的错误：AgentService 据此映射 ChatTurnResult.error（§3.1
// IPC 错误规范化）。与 import-service 的 "CODE: message" 前缀语义一致，
// 但直接挂 code 字段，避免主进程继续扩散字符串解析式错误判别。
export class DocumentSessionError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'DocumentSessionError'
  }
}

export interface DocumentSessionDeps {
  dbClient: Pick<DbClient, 'request'>
  fileClient: Pick<FileClient, 'request'>
}

export class DocumentSession {
  private deps: DocumentSessionDeps
  private cache = new Map<string, CacheEntry>()

  constructor(deps: DocumentSessionDeps) {
    this.deps = deps
  }

  async loadDocument(fileId: string): Promise<LoadedDocument> {
    const file = await this.deps.dbClient.request('file.get', { id: fileId })
    if (!file) {
      throw new DocumentSessionError('FILE_NOT_FOUND', `文件不存在：${fileId}`)
    }
    if (file.type !== 'word') {
      // Excel/PPT 对话属 T-S3 范围；当前工具链（replaceText）只支持 Word。
      throw new DocumentSessionError(
        'UNSUPPORTED_FILE_TYPE',
        `当前对话仅支持 Word 文档，该文件类型为 ${file.type}`
      )
    }

    const cached = this.cache.get(fileId)
    if (cached && cached.contentHash === file.contentHash) {
      return { file, paragraphs: cached.paragraphs }
    }

    let parsed: WordParseResult
    try {
      parsed = await this.deps.fileClient.request('word.parse', { sourcePath: file.path })
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      throw new DocumentSessionError('WORD_PARSE_FAILED', `文档解析失败：${reason}`)
    }

    const paragraphs = splitParagraphs(parsed.text).map((text, index) => ({ index, text }))
    this.cache.set(fileId, { contentHash: file.contentHash, paragraphs })
    return { file, paragraphs }
  }

  // ParagraphResolver 实现（replace-text-tool 契约）：同一实例同时服务
  // ReplaceTextTool（定位原文）与 AgentService（构建上下文），保证工具看到的
  // 段落与模型上下文里的段落同源。未加载过的 documentId 一律返回 undefined，
  // 让工具产出 LOCATION_NOT_FOUND 错误 ChangeSet（可恢复路径），不猜测。
  resolveParagraph = (documentId: string | undefined, index: number): string | undefined => {
    if (documentId === undefined) return undefined
    return this.cache.get(documentId)?.paragraphs[index]?.text
  }
}
