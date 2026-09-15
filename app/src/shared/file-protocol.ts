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

// —— Word 段落级写入（T-S2-05 信任交互「确认后写文件」，架构 §5 accept 分支）——
//
// 设计意图：
// - 架构 §3.4 把 mammoth 定位为"转 HTML 预览 / 纯文本抽取"，确定性改写必须走
//   OOXML 直改（mammoth 不具备无损写回能力）。这里用 JSZip 解包 docx → 定位
//   document.xml 中的目标 <w:p> → 保留 w:pPr / 首 run 的 w:rPr → 重写正文 →
//   重打包落盘，保证"应用后文档结构完整"（T-S2-05 验收标准）。
// - 段落号语义与解析侧严格对齐：splitParagraphs 的"非空段落从 0 计数"是唯一
//   规则源（word-parser.ts），写入器按同一口径给 <w:p> 建立序号，否则"模型
//   看到的段落号"与"实际改写的段落"会错位。
// - expectedBefore 对齐防线（T-S2-05 部分接受/延迟确认的安全闸）：每个编辑项
//   携带工具产出 ChangeSet 时的段落原文（AtomicChange.before.text），写入器
//   先校验目标段当前文本一致才落笔，不一致报 WORD_ALIGN_MISMATCH——绝不静默
//   错位改写（架构 §5.1 原子性约束的写入侧体现）。
export interface WordParagraphEdit {
  // 目标段落号（splitParagraphs 语义：非空段从 0 开始计数）。
  index: number
  // 替换后的整段文本（AtomicChange.after.text）。
  text: string
  // 写入前对齐校验：目标段当前文本必须与该值一致（AtomicChange.before.text）。
  // 省略时跳过校验（仅供测试与内部维护通道，信任流恒携带该值）。
  expectedBefore?: string
}

export interface WordApplyParagraphEditsPayload {
  // 源 .docx 的绝对路径（就地原子改写：写 .tmp → fsync → rename）。
  sourcePath: string
  // 段落编辑项集合。index 不得重复；写入在同一次重打包内完成。
  edits: WordParagraphEdit[]
}

export interface WordApplyParagraphEditsResult {
  // 写入后重解析的新正文哈希。accept 后由信任流用该值刷新 files.content_hash
  // 基线（架构 §2A.6 基线一致性），使后续轮次的编辑基线与磁盘事实同步。
  contentHash: string
  // 写入后文档的非空段落数。
  paragraphCount: number
  // 写入后文件字节数。
  byteSize: number
  // 写入完成时间（ISO 8601）。
  modifiedAt: string
}

export type FileRequestMap = {
  'file.ready': { request: undefined; response: { ok: true } }
  'word.parse': { request: WordParseRequestPayload; response: WordParseResult }
  'word.applyParagraphEdits': {
    request: WordApplyParagraphEditsPayload
    response: WordApplyParagraphEditsResult
  }
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
