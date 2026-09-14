// 文件引擎跨进程协议（架构 §2「所有跨进程消息类型集中定义于 shared/」）。
//
// 设计意图：
// - 文件解析（mammoth 抽取正文、后续 SheetJS/PPT 解析）是 CPU 密集操作，架构 §2 要求
//   "文件引擎必须运行在 Utility 进程"，防止阻塞主进程 IPC 与 SQLite 响应（7A.1）。
// - 该协议描述"主进程 ↔ 文件引擎 Utility 进程"之间的解析请求/响应，
//   与 DB 协议（db-protocol.ts）刻意分离：解析与写库分属两个独立 Utility 进程，
//   任何一侧崩溃不牵连另一侧，也避免"重解析大文件"卡住数据库写入。
// - 消息统一 { id, type, payload } 形态，与 db-protocol 保持一致，便于复用客户端骨架。

// Word 解析产出的中性结果。故意不含 title/wordCount 作为 DB 列——
// 架构 §4 的 files 表没有 title/wordCount 字段（name=文件名，字数未持久化建模）。
// 这里把字数、标题作为"派生元信息"返回，供上层写入 FTS5 metadata（可检索）
// 与 UI 展示，而非塞进 files 表制造 schema 漂移。
export interface WordParseResult {
  // 纯文本正文：用于 FTS5 全文索引与 content_hash 计算。
  text: string
  // 派生元信息（非 DB 列）：字数取自正文分词近似；
  // heading 为文档首个非空段落的启发式标题（mammoth extractRawText 不提供真实 Title 属性）。
  meta: {
    wordCount: number
    charCount: number
    heading: string | null
    // paragraphCount 供后续 diff/定位使用（LocationSelector.paragraph）。
    paragraphCount: number
  }
  // 正文内容哈希（sha256 hex）。架构 §4/§2A.6 只规定语义"内容哈希用于外部编辑感知"，
  // 未指定算法；此处选 sha256（Node 内置 crypto，无外部依赖，抗碰撞足够）。
  // 注意：哈希基于"解析出的正文文本"而非原始字节，语义是"应用内认知的最新内容"（§2A.6 基线一致性）。
  contentHash: string
}

export interface WordParseRequestPayload {
  // 源 .docx 的绝对路径。文件引擎进程直接读盘解析，避免大 Buffer 跨进程拷贝。
  sourcePath: string
}

export type FileRequestMap = {
  'file.ready': { request: undefined; response: { ok: true } }
  'word.parse': { request: WordParseRequestPayload; response: WordParseResult }
}

export type FileRequestType = keyof FileRequestMap

export interface FileRequest<T extends FileRequestType = FileRequestType> {
  id: string
  type: T
  payload: FileRequestMap[T]['request']
}

export type FileResponse<T extends FileRequestType = FileRequestType> =
  | {
      id: string
      ok: true
      payload: FileRequestMap[T]['response']
    }
  | {
      id: string
      ok: false
      error: { message: string; code?: string }
    }
