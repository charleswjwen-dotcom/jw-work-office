import type Database from 'better-sqlite3'
import type { SearchHit } from '../../shared/db-protocol'

export interface SearchRepository {
  indexFile(fileId: string, content: string, metadata?: string): void
  removeFile(fileId: string): void
  query(query: string, limit?: number): SearchHit[]
}

interface FtsRow {
  file_id: string
  snippet: string
  rank: number
}

// FTS5 MATCH 词法守卫（T-S2-08）：用户输入直接作 MATCH 参数会被 FTS5 当查询
// 语法解析——引号触发 fts5: syntax error，NEAR/AND/OR 裸词会改写匹配语义。
// 统一转成双引号包裹的字面短语（内部 " 转义为 ""），检索语义 = 原样包含该
// 关键词序列，与左栏「搜索文件名 / 正文关键词」的用户预期一致。
export function toFtsPhraseQuery(input: string): string {
  return `"${input.trim().replace(/"/g, '""')}"`
}

export class SqliteFtsSearchRepository implements SearchRepository {
  constructor(private readonly raw: Database.Database) {}

  indexFile(fileId: string, content: string, metadata = ''): void {
    const tx = this.raw.transaction(() => {
      this.raw.prepare('DELETE FROM fts_files WHERE file_id = ?').run(fileId)
      this.raw
        .prepare(
          'INSERT INTO fts_files (file_id, content, metadata) VALUES (?, ?, ?)'
        )
        .run(fileId, content, metadata)
    })
    tx()
  }

  removeFile(fileId: string): void {
    this.raw.prepare('DELETE FROM fts_files WHERE file_id = ?').run(fileId)
  }

  query(query: string, limit = 20): SearchHit[] {
    // 空串/纯空白直接短路：空 MATCH 会触发 fts5: syntax error。
    // 「无关键词 = 显示全部」是渲染层的过滤策略，不属于本接口语义。
    const trimmed = query.trim()
    if (trimmed.length === 0) return []
    const rows = this.raw
      .prepare(
        `SELECT file_id,
                snippet(fts_files, 1, '[', ']', '…', 12) AS snippet,
                rank AS rank
         FROM fts_files
         WHERE fts_files MATCH ?
         ORDER BY rank
         LIMIT ?`
      )
      .all(toFtsPhraseQuery(trimmed), limit) as FtsRow[]
    return rows.map((r) => ({
      fileId: r.file_id,
      snippet: r.snippet,
      rank: r.rank
    }))
  }
}
