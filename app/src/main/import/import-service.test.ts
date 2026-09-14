import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type DbHandle } from '../db/connection'
import { DataService } from '../db/data-service'
import type { DbRequestMap, DbRequestType, FileRecord } from '../../shared/db-protocol'
import type { FileRequestMap, FileRequestType } from '../../shared/file-protocol'
import { parseWordFile } from '../files/word-parser'
import { makeDocx } from '../files/__fixtures__/make-docx'
import { importWordFile } from './import-service'

// 集成测试：真实 mammoth 解析 + 真实 SQLite/FTS5，验证 T-S2-03 全链路。
// 用薄适配器把 FileClient/DbClient 的 request() 直接接到真实实现，
// 从而在无 Electron / 无子进程的 vitest 环境里跑通"解析→写库→索引"这条业务管线。

let workDir: string
let handle: DbHandle
let service: DataService

const WS = 'ws-test'

function dbAdapter() {
  return {
    async request<T extends DbRequestType>(
      type: T,
      payload: DbRequestMap[T]['request']
    ): Promise<DbRequestMap[T]['response']> {
      switch (type) {
        case 'file.create':
          return service.files.create(payload as FileRecord) as never
        case 'search.indexFile': {
          const p = payload as { fileId: string; content: string; metadata?: string }
          service.search.indexFile(p.fileId, p.content, p.metadata)
          return { ok: true } as never
        }
        case 'file.listByWorkspace': {
          const p = payload as { workspaceId: string }
          return service.files.listByWorkspace(p.workspaceId) as never
        }
        default:
          throw new Error(`unexpected db request in test: ${type}`)
      }
    }
  }
}

function fileAdapter() {
  return {
    async request<T extends FileRequestType>(
      type: T,
      payload: FileRequestMap[T]['request']
    ): Promise<FileRequestMap[T]['response']> {
      if (type === 'word.parse') {
        const p = payload as { sourcePath: string }
        return (await parseWordFile(p.sourcePath)) as never
      }
      throw new Error(`unexpected file request in test: ${type}`)
    }
  }
}

async function writeFixture(name: string, paragraphs: string[]): Promise<string> {
  const p = join(workDir, name)
  writeFileSync(p, await makeDocx(paragraphs))
  return p
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'mwo-import-'))
  handle = openDatabase(join(workDir, 'test.db'))
  service = new DataService({
    handle,
    dirs: { tmpDir: join(workDir, 'tmp'), changesetDir: workDir }
  })
  service.workspaces.ensure(WS, 'Test WS')
})

afterEach(() => {
  service.close()
  rmSync(workDir, { recursive: true, force: true })
})

describe('importWordFile integration (3 complexity levels)', () => {
  it('imports a simple single-paragraph docx', async () => {
    const src = await writeFixture('simple.docx', ['Hello quarterly revenue report'])
    const deps = { fileClient: fileAdapter(), dbClient: dbAdapter(), layout: { filesDir: workDir } }

    const result = await importWordFile(src, WS, deps)

    expect(result.file.type).toBe('word')
    expect(result.file.name).toBe('simple.docx')
    expect(result.file.contentHash).toMatch(/^[a-f0-9]{64}$/)
    expect(result.wordCount).toBeGreaterThan(0)
    // pageCount 诚实留空（LibreOffice 未接入）
    expect(result.file.pageCount).toBeNull()
    // 副本已原子写入工作区
    expect(existsSync(result.file.path)).toBe(true)
  })

  it('imports a multi-paragraph docx and extracts heading + word count', async () => {
    const src = await writeFixture('multi.docx', [
      'Annual Financial Summary',
      'Revenue increased across all regions.',
      'Operating margin improved by four points.',
      'Outlook remains positive for next year.'
    ])
    const deps = { fileClient: fileAdapter(), dbClient: dbAdapter(), layout: { filesDir: workDir } }

    const result = await importWordFile(src, WS, deps)

    expect(result.heading).toBe('Annual Financial Summary')
    expect(result.wordCount).toBeGreaterThan(10)
  })

  it('imports a CJK + special-char docx and is retrievable via FTS5', async () => {
    const src = await writeFixture('cjk.docx', [
      '季度经营分析报告',
      '本季度营业收入同比增长，毛利率提升。',
      'Special chars: <tag> & "quote" 100%'
    ])
    const deps = { fileClient: fileAdapter(), dbClient: dbAdapter(), layout: { filesDir: workDir } }

    const result = await importWordFile(src, WS, deps)
    expect(result.wordCount).toBeGreaterThan(0)

    // 验收核心：导入后可被 FTS5 检索命中
    const hits = service.search.query('营业收入')
    expect(hits.map((h) => h.fileId)).toContain(result.file.id)
  })

  it('lists imported files under the workspace', async () => {
    const deps = { fileClient: fileAdapter(), dbClient: dbAdapter(), layout: { filesDir: workDir } }
    await importWordFile(await writeFixture('a.docx', ['alpha content']), WS, deps)
    await importWordFile(await writeFixture('b.docx', ['beta content']), WS, deps)

    expect(service.files.listByWorkspace(WS)).toHaveLength(2)
  })

  it('rejects unsupported file types with a clear reason', async () => {
    const bad = join(workDir, 'note.txt')
    writeFileSync(bad, 'plain text')
    const deps = { fileClient: fileAdapter(), dbClient: dbAdapter(), layout: { filesDir: workDir } }

    await expect(importWordFile(bad, WS, deps)).rejects.toThrow(/UNSUPPORTED_FILE_TYPE/)
  })
})
