import { randomUUID } from 'node:crypto'
import { basename, extname, join } from 'node:path'
import { statSync } from 'node:fs'
import type { FileRecord } from '../../shared/db-protocol'
import type { FileClient } from '../files/client'
import type { DbClient } from '../db/client'
import { atomicWriteFileSync } from '../db/atomic-write'
import { readFileBytes } from '../files/word-parser'

// 导入编排器（T-S2-03 核心）。
//
// 它是"胶水层"，本身不做解析也不直接持有 SQLite 句柄，而是编排两个 Utility 进程：
//   FileClient（解析，CPU 密集） + DbClient（写库 + FTS5，同步事务）
// 这样符合架构 §2「主进程只做调度」——主进程侧只有这段轻量编排逻辑。
//
// 导入管线（对齐 T-S2-03 验收 + 架构 §5 原子写）：
//   ① 校验来源文件存在、类型受支持
//   ② 文件引擎解析：抽正文 + 派生元信息 + content_hash
//   ③ 原子写入 workspace 副本（写 .tmp → fsync → rename，§5）——
//      导入即把源文件复制进应用工作区，后续所有改写都针对副本，不动用户原始文件
//   ④ 写 files 表
//   ⑤ 触发 FTS5 索引（正文 + 元信息 metadata，使字数/标题可检索且不污染 files schema）
//
// 诚实标注的字段：
//   - pageCount = null：.docx 无固有页边界，权威分页需 LibreOffice（S2 未接入，架构 §4A.2）
//   - sheetCount = null：非表格文件
//   - title/wordCount 不入 files 表（§4 无此列），字数写进 FTS5 metadata

export interface ImportResult {
  file: FileRecord
  wordCount: number
  heading: string | null
}

export interface WorkspaceFsLayout {
  // 应用工作区内存放导入文件副本的目录（已 ensureDir）。
  filesDir: string
}

const SUPPORTED_WORD_EXT = new Set(['.docx', '.doc'])

function detectType(ext: string): FileRecord['type'] | null {
  if (SUPPORTED_WORD_EXT.has(ext)) return 'word'
  // Excel/PPT 解析在后续任务（T-S3）接入；此处仅识别 Word。
  return null
}

export interface ImportDeps {
  fileClient: Pick<FileClient, 'request'>
  dbClient: Pick<DbClient, 'request'>
  layout: WorkspaceFsLayout
}

export async function importWordFile(
  sourcePath: string,
  workspaceId: string,
  deps: ImportDeps
): Promise<ImportResult> {
  const ext = extname(sourcePath).toLowerCase()
  const type = detectType(ext)
  if (type !== 'word') {
    throw new Error(`UNSUPPORTED_FILE_TYPE: ${ext || '(no extension)'}`)
  }

  // ① 校验存在性并取 mtime/size（modified_at 用文件系统 mtime，对齐 §4 "modified_at=mtime"）
  const stat = statSync(sourcePath)

  // ② 解析（走文件引擎 Utility 进程）
  const parsed = await deps.fileClient.request('word.parse', { sourcePath })

  // ③ 原子写副本到工作区。副本名带 uuid 前缀避免同名覆盖，保留原始扩展名。
  const fileId = randomUUID()
  const destPath = join(deps.layout.filesDir, `${fileId}${ext}`)
  const bytes = await readFileBytes(sourcePath)
  atomicWriteFileSync(destPath, bytes)

  // ④ 写 files 表
  const now = Date.now()
  const record: FileRecord = {
    id: fileId,
    workspaceId,
    name: basename(sourcePath),
    type,
    path: destPath,
    size: stat.size,
    pageCount: null, // 见文件顶部说明：LibreOffice 未接入，分页留空待补
    sheetCount: null,
    tags: null,
    thumbnail: null,
    currentVersionId: null,
    contentHash: parsed.contentHash,
    importedAt: now,
    modifiedAt: stat.mtimeMs,
    remoteId: null,
    etag: null,
    syncState: 'local',
    updatedBy: null
  }
  const file = await deps.dbClient.request('file.create', record)

  // ⑤ FTS5 索引：正文入 content 列；派生元信息（字数/标题/文件名）入 metadata 列，
  //    使这些不落 files 表的信息仍可被全文检索命中（架构 §4 fts_files(file_id,content,metadata)）。
  const metadata = [file.name, parsed.meta.heading ?? '', `words:${parsed.meta.wordCount}`]
    .filter(Boolean)
    .join(' ')
  await deps.dbClient.request('search.indexFile', {
    fileId: file.id,
    content: parsed.text,
    metadata
  })

  return { file, wordCount: parsed.meta.wordCount, heading: parsed.meta.heading }
}
