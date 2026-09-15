import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type DbHandle } from '../db/connection'
import { DataService } from '../db/data-service'
import { copyFileAtomicSync } from '../db/atomic-write'
import type {
  ChangeSetRecord,
  DbRequestMap,
  DbRequestType,
  FileRecord,
  VersionRecord
} from '../../shared/db-protocol'
import type { FileRequestMap, FileRequestType } from '../../shared/file-protocol'
import type { AtomicChange, ChangeSet } from '../../shared/agent'
import { parseWordFile, splitParagraphs } from '../files/word-parser'
import { applyParagraphEdits } from '../files/word-writer'
import { makeDocx } from '../files/__fixtures__/make-docx'
import { importWordFile } from '../import/import-service'
import { TrustService } from './trust-service'
import { VersionService } from './version-service'
import { ExternalWatchService } from './external-watch'

// T-S2-05A 第 2 层集成测试：真实 SQLite + 真实 mammoth/JSZip（与
// trust-service.test.ts 同一可测试性约定——端口适配器直连进程内实现），
// 直击任务验收标准：
// - 外部编辑检出（mtime 预筛 → contentHash 权威比对）且自身写入不误报；
// - 外部改动绝不静默覆盖：pending 置 stale、三选项显式处置；
// - 采纳：external ChangeSet + author=external 版本（三种来源均可追溯）；
// - 忽略：仅推进基线，账本干净——随后手动微调立即可用（第 1/2 层闭环）；
// - 内容一致仅 mtime 前移：静默重定基线，无版本无检出、幂等。

let workDir: string
let handle: DbHandle
let service: DataService
let snapshotsDir: string

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
        case 'file.get':
          return service.files.get((payload as { id: string }).id) as never
        case 'file.update': {
          const p = payload as { id: string; patch: Partial<FileRecord> }
          return service.files.update(p.id, p.patch) as never
        }
        case 'file.listByWorkspace': {
          const p = payload as { workspaceId: string }
          return service.files.listByWorkspace(p.workspaceId) as never
        }
        // T-S2-05A 扫描入口：跨工作区全量清单（含 contentHash/modifiedAt 基线）。
        case 'file.listAll':
          return service.files.listAll() as never
        case 'search.indexFile': {
          const p = payload as { fileId: string; content: string; metadata?: string }
          service.search.indexFile(p.fileId, p.content, p.metadata)
          return { ok: true } as never
        }
        // 关键：changeSet.create 必须走 DataService.createChangeSet——
        // 只有它实现 >512KB 外置文件策略（§4），直连 repository 会绕过外置化。
        case 'changeSet.create':
          return service.createChangeSet(payload as ChangeSetRecord) as never
        case 'changeSet.listPending':
          return service.changeSets.listPending() as never
        case 'changeSet.listPendingResolved':
          return service.listPendingResolved() as never
        case 'changeSet.getResolved':
          return service.getResolvedChangeSet((payload as { id: string }).id) as never
        case 'changeSet.discard':
          return service.discardChangeSet((payload as { id: string }).id) as never
        case 'changeSet.updateStatus': {
          const p = payload as { id: string; status: ChangeSetRecord['status'] }
          return service.changeSets.updateStatus(p.id, p.status) as never
        }
        // T-S2-05A 冲突消解：检出视图里的 stalePendingCount 数据源。
        case 'changeSet.countByFileStatus': {
          const p = payload as { fileId: string; status: ChangeSetRecord['status'] }
          return { count: service.changeSets.countByFileStatus(p.fileId, p.status) } as never
        }
        case 'version.create':
          return service.versions.create(payload as VersionRecord) as never
        case 'version.listByFile':
          return service.versions.listByFile((payload as { fileId: string }).fileId) as never
        case 'version.get':
          return service.versions.get((payload as { id: string }).id) as never
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
      if (type === 'word.applyParagraphEdits') {
        const p = payload as {
          sourcePath: string
          edits: Parameters<typeof applyParagraphEdits>[1]
        }
        return (await applyParagraphEdits(p.sourcePath, p.edits)) as never
      }
      // 与 files/worker.ts 同一实现：splitParagraphs 唯一规则源切段。
      if (type === 'word.parseParagraphs') {
        const p = payload as { sourcePath: string }
        const parsed = await parseWordFile(p.sourcePath)
        return { paragraphs: splitParagraphs(parsed.text) } as never
      }
      // 与 files/worker.ts 同一实现：.tmp→fsync→rename 原子复制。
      if (type === 'file.copy') {
        const p = payload as { sourcePath: string; destPath: string }
        return { byteSize: copyFileAtomicSync(p.sourcePath, p.destPath) } as never
      }
      throw new Error(`unexpected file request in test: ${type}`)
    }
  }
}

function buildStack() {
  const versionService = new VersionService({
    dbPort: dbAdapter(),
    filePort: fileAdapter(),
    snapshotsDir
  })
  const trustService = new TrustService({
    dbPort: dbAdapter(),
    filePort: fileAdapter(),
    version: versionService
  })
  const externalWatch = new ExternalWatchService({
    dbPort: dbAdapter(),
    filePort: fileAdapter(),
    versionPort: versionService,
    filesDir: workDir
  })
  return { trustService, versionService, externalWatch }
}

async function importDocx(name: string, paragraphs: string[]) {
  const src = join(workDir, name)
  writeFileSync(src, await makeDocx(paragraphs))
  return importWordFile(src, WS, {
    fileClient: fileAdapter(),
    dbClient: dbAdapter(),
    layout: { filesDir: workDir }
  })
}

function textChange(id: string, index: number, before: string, after: string): AtomicChange {
  return {
    id,
    location: { type: 'paragraph', index },
    kind: 'text',
    before: { text: before },
    after: { text: after },
    renderHint: 'inline'
  }
}

function makeChangeSet(id: string, changes: AtomicChange[]): ChangeSet {
  return {
    id,
    toolName: 'replaceText',
    status: 'pending',
    changes,
    createdAt: new Date().toISOString()
  }
}

function currentVersionIdOf(fileId: string): string {
  const id = service.files.get(fileId)?.currentVersionId
  expect(id).toBeTruthy()
  return id as string
}

function versionAt(id: string | null | undefined): VersionRecord {
  expect(id).toBeTruthy()
  const record = service.versions.get(id as string)
  expect(record).toBeTruthy()
  return record as VersionRecord
}

// 模拟外部编辑（应用外保存）：覆盖磁盘内容并把基线 modifiedAt 回拨 10s——
// 等效于「基线落定后磁盘又被外部保存」，越过 mtime 预筛的 2s 自身写入余量
// （MTIME_SLACK_MS 只豁免应用自身写入）。
async function externalEdit(path: string, fileId: string, paragraphs: string[]): Promise<void> {
  writeFileSync(path, await makeDocx(paragraphs))
  service.files.update(fileId, { modifiedAt: Date.now() - 10_000 })
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'mwo-ext-'))
  handle = openDatabase(join(workDir, 'test.db'))
  snapshotsDir = join(workDir, 'snapshots')
  mkdirSync(snapshotsDir)
  service = new DataService({
    handle,
    dirs: { tmpDir: join(workDir, 'tmp'), changesetDir: workDir, snapshotsDir }
  })
  service.workspaces.ensure(WS, 'Test WS')
})

afterEach(() => {
  service.close()
  rmSync(workDir, { recursive: true, force: true })
})

describe('ExternalWatchService 外部编辑感知（T-S2-05A 第 2 层验收）', () => {
  it('检出：外部改写越基线 → pending 置 stale + 检出视图 + diff 预览；自身写入不误报', async () => {
    const imp = await importDocx('watch.docx', ['外部感知第一段。', '外部感知基线第二段。'])
    const { trustService, externalWatch } = buildStack()

    // 先落一个 AI 变更并接受 → v1 版本基线（快照在位，diff 有基准）
    await trustService.persistPending(
      makeChangeSet('cs-ai', [textChange('c1', 0, '外部感知第一段。', 'AI 改写第一段。')]),
      imp.file.id,
      null
    )
    await trustService.accept('cs-ai')

    // 自身写入不误报（红线）：accept 刚落基线 modifiedAt=Date.now()，磁盘
    // mtime 在 2s 余量内 → 首轮扫描零检出，不进入哈希比对。
    expect(await externalWatch.scan()).toEqual([])

    // 落一个未确认 pending（将被外部编辑打成 stale）
    await trustService.persistPending(
      makeChangeSet('cs-pending', [
        textChange('c2', 1, '外部感知基线第二段。', '永远不会写入的文本')
      ]),
      imp.file.id,
      null
    )

    await externalEdit(imp.file.path, imp.file.id, ['AI 改写第一段。', '第二段被外部改写。'])

    const detections = await externalWatch.scan()
    expect(detections).toHaveLength(1)
    expect(detections[0]).toMatchObject({
      fileId: imp.file.id,
      fileName: 'watch.docx',
      stalePendingCount: 1
    })
    expect((detections[0]?.diskModifiedAt ?? 0) > (detections[0]?.baselineModifiedAt ?? 0)).toBe(
      true
    )

    // 冲突消解（验收）：pending 置 stale、退出待确认列表、不可再 accept
    expect(service.changeSets.get('cs-pending')?.status).toBe('stale')
    expect(await trustService.listPendingViews()).toEqual([])
    await expect(trustService.accept('cs-pending')).rejects.toMatchObject({
      code: 'CHANGESET_NOT_PENDING'
    })

    // 外部改动绝不静默覆盖：磁盘保持外部内容，pending 的 after 未写入
    const disk = await parseWordFile(imp.file.path)
    expect(disk.text).toContain('第二段被外部改写。')
    expect(disk.text).not.toContain('永远不会写入的文本')

    // diff 预览：before=当前版本快照（旧文），after=磁盘（新文）
    const diff = await externalWatch.getExternalDiff(imp.file.id)
    expect(diff).toHaveLength(1)
    expect(diff[0]).toMatchObject({
      location: { type: 'paragraph', index: 1 },
      kind: 'text',
      before: { text: '外部感知基线第二段。' },
      after: { text: '第二段被外部改写。' }
    })
  })

  it('采纳：external ChangeSet + author=external 版本 + 基线推进，重扫归零、重复处置被拦', async () => {
    const imp = await importDocx('accept.docx', ['采纳前第一段。', '采纳前第二段。'])
    const { trustService, externalWatch } = buildStack()

    await trustService.persistPending(
      makeChangeSet('cs-ai', [textChange('c1', 0, '采纳前第一段。', '采纳前第一段·AI 改。')]),
      imp.file.id,
      null
    )
    await trustService.accept('cs-ai')
    const v1Id = currentVersionIdOf(imp.file.id)

    await externalEdit(imp.file.path, imp.file.id, ['采纳前第一段·AI 改。', '第二段被外部改写。'])
    expect(await externalWatch.scan()).toHaveLength(1)

    const payload = await externalWatch.acceptExternal(imp.file.id)
    expect(payload.contentHash).toBeTruthy()

    // 审计（验收：三种来源均可追溯）：external ChangeSet 出生即 applied
    const record = service.getResolvedChangeSet(payload.changeSetId)
    expect(record?.source).toBe('external')
    expect(record?.status).toBe('applied')
    expect(record?.sourceCommand).toBe('外部编辑采纳')
    expect(record?.updatedBy).toBe('user')
    expect(record?.changes as AtomicChange[]).toHaveLength(1)

    // 版本（验收：外部采纳与 AI/手动同链路可回退）：author=external、父链、快照=磁盘新文
    const v2 = versionAt(payload.versionId)
    expect(v2.seq).toBe(2)
    expect(v2.author).toBe('external')
    expect(v2.changeSummary).toBe('外部编辑 1/1 项')
    expect(v2.parentVersionId).toBe(v1Id)
    expect(v2.changeSetId).toBe(payload.changeSetId)
    expect(readFileSync(v2.snapshotPath as string).equals(readFileSync(imp.file.path))).toBe(true)

    // 基线推进 + 指针移动（§5.1 单一事实源）
    const file = service.files.get(imp.file.id)
    expect(file?.contentHash).toBe(payload.contentHash)
    expect(file?.currentVersionId).toBe(payload.versionId)

    // 检出清空、重扫不再检出（基线已推进）
    expect(externalWatch.listDetected()).toEqual([])
    expect(await externalWatch.scan()).toEqual([])

    // 处置前复检：磁盘现状与基线一致 → 重复采纳/忽略均被拦下
    await expect(externalWatch.acceptExternal(imp.file.id)).rejects.toMatchObject({
      code: 'EXTERNAL_NOT_DETECTED'
    })
    await expect(externalWatch.ignoreExternal(imp.file.id)).rejects.toMatchObject({
      code: 'EXTERNAL_NOT_DETECTED'
    })
  })

  it('忽略：仅推进基线、账本干净，随后手动微调立即可用（第 1/2 层闭环）', async () => {
    const imp = await importDocx('ignore.docx', ['忽略路径唯一段落。'])
    const { trustService, externalWatch } = buildStack()

    await externalEdit(imp.file.path, imp.file.id, ['忽略后被外部改写。'])
    expect(await externalWatch.scan()).toHaveLength(1)

    const newHash = await externalWatch.ignoreExternal(imp.file.id)
    const disk = await parseWordFile(imp.file.path)
    expect(disk.contentHash).toBe(newHash)

    // 仅推进基线：无版本、无变更记录（"看过且放弃"不是内容事件）
    const file = service.files.get(imp.file.id)
    expect(file?.contentHash).toBe(newHash)
    expect(file?.currentVersionId).toBeNull()
    expect(service.versions.listByFile(imp.file.id)).toEqual([])
    const rows = handle.raw
      .prepare('SELECT COUNT(*) AS n FROM change_sets WHERE file_id = ?')
      .get(imp.file.id) as { n: number }
    expect(rows.n).toBe(0)

    // 检出清空、重扫零检出
    expect(externalWatch.listDetected()).toEqual([])
    expect(await externalWatch.scan()).toEqual([])

    // 第 1/2 层闭环：基线一致后手动微调立即可用（不再 BASELINE_MISMATCH）
    const res = await trustService.createManualPending(imp.file.id, [
      { index: 0, text: '手动接管改写。' }
    ])
    expect(res.changeCount).toBe(1)
    expect(service.changeSets.get(res.changeSet?.id as string)?.source).toBe('manual')
  })

  it('无版本基线：diff 拒看但可采纳——版本照建、摘要诚实记 0/0 项（不虚构变更）', async () => {
    const imp = await importDocx('nobase.docx', ['无基线第一段。', '无基线第二段。'])
    const { externalWatch } = buildStack()

    await externalEdit(imp.file.path, imp.file.id, ['无基线第一段被外部改了。', '无基线第二段。'])
    expect(await externalWatch.scan()).toHaveLength(1)

    // 无版本（导入后从未 accept）→ diff 没有基准，但采纳/忽略仍可用
    await expect(externalWatch.getExternalDiff(imp.file.id)).rejects.toMatchObject({
      code: 'EXTERNAL_DIFF_NO_BASELINE'
    })

    const payload = await externalWatch.acceptExternal(imp.file.id)

    // 版本照建：快照=磁盘现状（字节级），seq 从 1 起
    const v1 = versionAt(payload.versionId)
    expect(v1.seq).toBe(1)
    expect(v1.author).toBe('external')
    expect(v1.changeSummary).toBe('外部编辑 0/0 项')
    const record = service.getResolvedChangeSet(payload.changeSetId)
    expect(record?.changes).toEqual([])
    expect(readFileSync(v1.snapshotPath as string).equals(readFileSync(imp.file.path))).toBe(true)
    expect(service.files.get(imp.file.id)?.currentVersionId).toBe(payload.versionId)
  })

  it('内容一致仅 mtime 前移：静默重定基线，无版本无检出、幂等', async () => {
    const imp = await importDocx('rebase.docx', ['重定基线测试段落。'])
    const { externalWatch } = buildStack()

    // 同字节重写（另存/复制未改内容场景）：mtime 前移、contentHash 不变
    writeFileSync(imp.file.path, readFileSync(imp.file.path))
    service.files.update(imp.file.id, { modifiedAt: Date.now() - 10_000 })

    expect(await externalWatch.scan()).toEqual([])

    // 静默重定基线：无版本记录、无检出，modifiedAt 推进到磁盘 mtime
    expect(service.versions.listByFile(imp.file.id)).toEqual([])
    expect(externalWatch.listDetected()).toEqual([])
    const file = service.files.get(imp.file.id)
    expect(file?.modifiedAt).toBeGreaterThanOrEqual(Math.floor(statSync(imp.file.path).mtimeMs))

    // 幂等：再扫仍零检出
    expect(await externalWatch.scan()).toEqual([])
  })
})
