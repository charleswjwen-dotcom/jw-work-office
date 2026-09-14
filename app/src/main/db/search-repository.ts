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
      .all(query, limit) as FtsRow[]
    return rows.map((r) => ({
      fileId: r.file_id,
      snippet: r.snippet,
      rank: r.rank
    }))
  }
}
