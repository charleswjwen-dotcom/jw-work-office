import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type DbHandle } from './connection'
import { DataService } from './data-service'
import { CHANGES_EXTERNAL_THRESHOLD } from './recovery'
import type { ChangeSetRecord, FileRecord } from '../../shared/db-protocol'

let workDir: string
let handle: DbHandle
let service: DataService

function makeFile(overrides: Partial<FileRecord> = {}): FileRecord {
  const now = Date.now()
  return {
    id: 'f1',
    workspaceId: 'w1',
    name: 'report.docx',
    type: 'word',
    path: '/docs/report.docx',
    size: 1024,
    pageCount: 3,
    sheetCount: null,
    tags: ['q3'],
    thumbnail: null,
    currentVersionId: null,
    contentHash: 'hash-abc',
    importedAt: now,
    modifiedAt: now,
    remoteId: null,
    etag: null,
    syncState: 'local',
    updatedBy: null,
    ...overrides
  }
}

function makeChangeSet(overrides: Partial<ChangeSetRecord> = {}): ChangeSetRecord {
  return {
    id: 'cs1',
    fileId: 'f1',
    source: 'ai',
    sourceCommand: 'rewrite intro',
    status: 'pending',
    changes: { ops: [] },
    changesPath: null,
    remoteId: null,
    etag: null,
    syncState: 'local',
    updatedBy: null,
    ...overrides
  }
}

function seedWorkspace(): void {
  handle.raw.prepare('INSERT INTO workspaces (id, name) VALUES (?, ?)').run('w1', 'WS')
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'mwo-db-'))
  handle = openDatabase(join(workDir, 'test.db'))
  service = new DataService({
    handle,
    dirs: { tmpDir: join(workDir, 'tmp'), changesetDir: workDir }
  })
  seedWorkspace()
})

afterEach(() => {
  service.close()
  rmSync(workDir, { recursive: true, force: true })
})

describe('migrations', () => {
  it('creates all base tables plus fts_files', () => {
    const rows = handle.raw
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table')")
      .all() as { name: string }[]
    const names = rows.map((r) => r.name)
    expect(names).toContain('files')
    expect(names).toContain('versions')
    expect(names).toContain('change_sets')
    expect(names).toContain('fts_files')
  })

  // 回归：迁移必须幂等。历史缺陷是每次启动全量重放裸 CREATE TABLE，
  // 二次打开同一库因“表已存在”抛错 → 数据层永远 NOT_READY（e2e 二次跑超时）。
  // 记账表 + 基线检测修复后，重复 openDatabase 应安全无异常。
  it('re-opening the same db file does not re-run migrations (idempotent)', () => {
    const dbFile = join(workDir, 'reopen.db')
    const first = openDatabase(dbFile)
    first.close()
    // 二次打开：既有 schema 已存在，若迁移非幂等此处会抛错。
    expect(() => {
      const second = openDatabase(dbFile)
      const rows = second.raw
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='files'")
        .all() as { name: string }[]
      expect(rows).toHaveLength(1)
      second.close()
    }).not.toThrow()
  })
})

describe('FileRepository CRUD', () => {
  it('creates, reads, updates and deletes a file', () => {
    const created = service.files.create(makeFile())
    expect(created.contentHash).toBe('hash-abc')

    const fetched = service.files.get('f1')
    expect(fetched?.name).toBe('report.docx')

    const updated = service.files.update('f1', { name: 'final.docx', size: 2048 })
    expect(updated?.name).toBe('final.docx')
    expect(updated?.size).toBe(2048)

    expect(service.files.listByWorkspace('w1', 'word')).toHaveLength(1)
    expect(service.files.delete('f1')).toBe(1)
    expect(service.files.get('f1')).toBeNull()
  })
})

describe('SqliteFtsSearchRepository', () => {
  it('indexes and returns matching hits', () => {
    service.search.indexFile('f1', 'quarterly revenue grew strongly', 'report')
    service.search.indexFile('f2', 'holiday party planning notes', 'memo')

    const hits = service.search.query('revenue')
    expect(hits).toHaveLength(1)
    expect(hits[0].fileId).toBe('f1')

    service.search.removeFile('f1')
    expect(service.search.query('revenue')).toHaveLength(0)
  })
})

describe('crash recovery', () => {
  it('reports pending change sets without applying them', () => {
    service.files.create(makeFile())
    service.createChangeSet(makeChangeSet({ status: 'pending' }))
    service.createChangeSet(makeChangeSet({ id: 'cs2', status: 'applied' }))

    const result = service.runRecovery()
    expect(result.pending.map((c) => c.id)).toEqual(['cs1'])
  })

  it('cleans orphan external .changeset file (delete file then row)', () => {
    service.files.create(makeFile())
    const big = { blob: 'x'.repeat(CHANGES_EXTERNAL_THRESHOLD + 10) }
    const cs = service.createChangeSet(makeChangeSet({ changes: big }))
    expect(cs.changesPath).not.toBeNull()
    expect(existsSync(cs.changesPath as string)).toBe(true)

    service.changeSets.updateStatus('cs1', 'discarded')
    const result = service.runRecovery()
    expect(result.cleanedExternal).toBe(1)
    expect(existsSync(cs.changesPath as string)).toBe(false)
  })
})

describe('changes_path threshold externalization', () => {
  it('keeps small changes inline', () => {
    service.files.create(makeFile())
    const cs = service.createChangeSet(makeChangeSet())
    expect(cs.changesPath).toBeNull()
    expect(cs.changes).not.toBeNull()
  })

  it('writes over-threshold changes to external file and nulls the column', () => {
    service.files.create(makeFile())
    const big = { blob: 'y'.repeat(CHANGES_EXTERNAL_THRESHOLD + 100) }
    const cs = service.createChangeSet(makeChangeSet({ changes: big }))
    expect(cs.changes).toBeNull()
    expect(cs.changesPath).not.toBeNull()
    expect(existsSync(cs.changesPath as string)).toBe(true)

    const stored = service.changeSets.get('cs1')
    expect(stored).not.toBeNull()
    const roundTrip = service.readChangeSetChanges(stored as ChangeSetRecord)
    expect(roundTrip).toEqual(big)
  })
})
