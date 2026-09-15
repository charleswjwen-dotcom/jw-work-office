import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
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
import { SNAPSHOT_SUFFIX, VersionService } from './version-service'

// T-S2-06 快照与线性回溯集成测试：真实 SQLite + 真实 mammoth/JSZip（与
// trust-service.test.ts 同一可测试性约定——端口适配器直连进程内实现），
// 直击任务验收标准：
// - ④ 集成测试：导入→修改→快照→再修改→回溯，验证文件内容正确恢复；
// - ① 回溯后文件内容与快照一致（对后像快照逐字节比对）；
// - ② 回溯操作本身也产生 ChangeSet 与版本（可再回溯）；
// - ③ 无原子性漏洞：错误分支不动文件；同文件 pending 被同构清理；
//   孤儿快照可被崩溃恢复清走（recovery.ts 的 cleanedSnapshots 口径）。

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
        case 'changeSet.getResolved':
          return service.getResolvedChangeSet((payload as { id: string }).id) as never
        case 'changeSet.discard':
          return service.discardChangeSet((payload as { id: string }).id) as never
        case 'changeSet.updateStatus': {
          const p = payload as { id: string; status: ChangeSetRecord['status'] }
          return service.changeSets.updateStatus(p.id, p.status) as never
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
  return { trustService, versionService }
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

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'mwo-version-'))
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

describe('VersionService 快照与线性回溯（T-S2-06 验收）', () => {
  it('全链路：导入→修改→快照→再修改→回溯，文件与快照逐字节一致、回溯可再回溯（验收①②④）', async () => {
    const imp = await importDocx('report.docx', ['版本测试第一段。', '版本测试第二段。'])
    const { trustService, versionService } = buildStack()

    // 修改①：accept 生成后像快照 v1（§5 7A.3：快照写成功才移指针）
    await trustService.persistPending(
      makeChangeSet('cs-1', [textChange('c1', 0, '版本测试第一段。', '修改后第一段。')]),
      imp.file.id,
      null
    )
    await trustService.accept('cs-1')

    const v1 = versionAt(currentVersionIdOf(imp.file.id))
    expect(v1.seq).toBe(1)
    expect(v1.author).toBe('ai')
    expect(v1.parentVersionId).toBeNull()
    expect(v1.changeSetId).toBe('cs-1')
    expect(v1.changeSummary).toBe('AI 修改 1/1 项')
    expect(v1.snapshotPath?.endsWith(SNAPSHOT_SUFFIX)).toBe(true)
    expect(existsSync(v1.snapshotPath as string)).toBe(true)
    // 快照是 accept 后工作文件的字节级事实（T-S0-04 结论③：回溯以快照为准）
    expect(readFileSync(v1.snapshotPath as string).equals(readFileSync(imp.file.path))).toBe(true)

    // 修改②：再 accept 生成 v2，父链指向 v1
    await trustService.persistPending(
      makeChangeSet('cs-2', [textChange('c2', 1, '版本测试第二段。', '修改后第二段。')]),
      imp.file.id,
      null
    )
    await trustService.accept('cs-2')
    const v2 = versionAt(currentVersionIdOf(imp.file.id))
    expect(v2.seq).toBe(2)
    expect(v2.parentVersionId).toBe(v1.id)

    const afterV2 = await parseWordFile(imp.file.path)
    expect(afterV2.text).toContain('修改后第一段。')
    expect(afterV2.text).toContain('修改后第二段。')

    // 回溯到 v1：文件内容正确恢复（验收④/①）
    const payload = await versionService.restore(v1.id)
    expect(payload.appliedCount).toBe(1)

    const restored = await parseWordFile(imp.file.path)
    expect(restored.text).toContain('修改后第一段。') // cs1 保留
    expect(restored.text).not.toContain('修改后第二段。') // cs2 被回退
    expect(restored.text).toContain('版本测试第二段。')
    expect(readFileSync(imp.file.path).equals(readFileSync(v1.snapshotPath as string))).toBe(true)

    // 反向 ChangeSet：出生即 applied，可审计"谁在何时恢复到哪版"（§5）
    const reverse = service.getResolvedChangeSet(payload.changeSetId)
    expect(reverse?.status).toBe('applied')
    expect(reverse?.source).toBe('manual')
    expect(reverse?.sourceCommand).toBe('恢复到版本 v1')
    expect(reverse?.changes as AtomicChange[]).toHaveLength(1)

    // 回溯自身的后像快照 v3：不与目标版本共享快照文件（孤儿清理按行引用判定）
    const v3 = versionAt(payload.versionId)
    expect(v3.seq).toBe(3)
    expect(v3.author).toBe('user')
    expect(v3.changeSummary).toBe('回溯至版本 v1')
    expect(v3.parentVersionId).toBe(v2.id)
    expect(v3.snapshotPath).not.toBe(v1.snapshotPath)
    expect(existsSync(v3.snapshotPath as string)).toBe(true)

    // 指针与基线（§5 7A.3 / §2A.6）
    const file = service.files.get(imp.file.id)
    expect(file?.currentVersionId).toBe(payload.versionId)
    expect(file?.contentHash).toBe(payload.contentHash)
    expect(restored.contentHash).toBe(payload.contentHash)

    // 版本历史视图：seq 降序 + isCurrent 只标当前（版本面板数据源）
    const views = await versionService.listVersionViews(imp.file.id)
    expect(views.map((v) => v.seq)).toEqual([3, 2, 1])
    expect(views.filter((v) => v.isCurrent).map((v) => v.id)).toEqual([payload.versionId])

    // 验收②：回溯自身产生 ChangeSet 与版本 → 可再回溯（这次回到 v2）
    const again = await versionService.restore(v2.id)
    const v4 = versionAt(again.versionId)
    expect(v4.seq).toBe(4)
    expect(v4.parentVersionId).toBe(v3.id)
    const backToV2 = await parseWordFile(imp.file.path)
    expect(backToV2.text).toContain('修改后第一段。')
    expect(backToV2.text).toContain('修改后第二段。')
    expect(readFileSync(imp.file.path).equals(readFileSync(v2.snapshotPath as string))).toBe(true)
  })

  it('getVersionDiff：回溯前 1 处差异（红=现在、绿=恢复后），回溯后归零；当前版本恢复被拒', async () => {
    const imp = await importDocx('diff.docx', ['差异预览第一段。', '差异预览第二段。'])
    const { trustService, versionService } = buildStack()

    await trustService.persistPending(
      makeChangeSet('cs-1', [textChange('c1', 0, '差异预览第一段。', '改写第一段。')]),
      imp.file.id,
      null
    )
    await trustService.accept('cs-1')
    const v1 = versionAt(currentVersionIdOf(imp.file.id))

    await trustService.persistPending(
      makeChangeSet('cs-2', [textChange('c2', 1, '差异预览第二段。', '改写第二段。')]),
      imp.file.id,
      null
    )
    await trustService.accept('cs-2')

    // 回溯前：当前（v2 态）→ v1 快照，第 1 段存在替换差异
    const diff = await versionService.getVersionDiff(v1.id)
    expect(diff.versionId).toBe(v1.id)
    expect(diff.seq).toBe(1)
    expect(diff.changes).toHaveLength(1)
    expect(diff.changes[0]).toMatchObject({
      location: { type: 'paragraph', index: 1 },
      before: { text: '改写第二段。' },
      after: { text: '差异预览第二段。' }
    })

    await versionService.restore(v1.id)

    // 回溯后：当前内容已等于 v1 快照 → diff 归零
    const after = await versionService.getVersionDiff(v1.id)
    expect(after.changes).toEqual([])

    // ALREADY_CURRENT：当前版本（回溯产生的 v3）不可再恢复
    await expect(versionService.restore(currentVersionIdOf(imp.file.id))).rejects.toMatchObject({
      code: 'ALREADY_CURRENT'
    })
  })

  it('错误分支：VERSION_NOT_FOUND / SNAPSHOT_MISSING / FILE_NOT_FOUND', async () => {
    const { trustService, versionService } = buildStack()

    await expect(versionService.restore('no-such-version')).rejects.toMatchObject({
      code: 'VERSION_NOT_FOUND'
    })
    await expect(versionService.getVersionDiff('no-such-version')).rejects.toMatchObject({
      code: 'VERSION_NOT_FOUND'
    })

    const imp = await importDocx('err.docx', ['错误分支测试段落'])
    await trustService.persistPending(
      makeChangeSet('cs-1', [textChange('c1', 0, '错误分支测试段落', '错误分支改写。')]),
      imp.file.id,
      null
    )
    await trustService.accept('cs-1')

    // SNAPSHOT_MISSING：versions 行在、快照文件字段为空（diff 存储未落地等场景）
    service.versions.create({
      id: 'v-nosnap',
      fileId: imp.file.id,
      seq: 99,
      createdAt: Date.now(),
      triggerCommand: null,
      author: 'external',
      changeSummary: null,
      storageType: 'diff',
      snapshotPath: null,
      changeSetId: null,
      parentVersionId: null,
      remoteId: null,
      etag: null,
      syncState: 'local',
      updatedBy: null
    })
    await expect(versionService.restore('v-nosnap')).rejects.toMatchObject({
      code: 'SNAPSHOT_MISSING'
    })
    await expect(versionService.getVersionDiff('v-nosnap')).rejects.toMatchObject({
      code: 'SNAPSHOT_MISSING'
    })

    // FILE_NOT_FOUND：版本与快照路径在位，但文件行已删除。正常路径下
        // versions.file_id 的 FK cascade 会连带删掉版本行（不可能留下孤儿版本），
        // 该分支是防御代码——临时关 FK 模拟库不一致状态来覆盖它。
        const imp2 = await importDocx('ghost.docx', ['即将被删除的文件'])
    service.versions.create({
      id: 'v-ghost',
      fileId: imp2.file.id,
      seq: 1,
      createdAt: Date.now(),
      triggerCommand: null,
      author: 'user',
      changeSummary: null,
      storageType: 'full',
      snapshotPath: imp2.file.path,
      changeSetId: null,
      parentVersionId: null,
      remoteId: null,
      etag: null,
      syncState: 'local',
      updatedBy: null
    })
    handle.raw.pragma('foreign_keys = OFF')
        service.files.delete(imp2.file.id)
        handle.raw.pragma('foreign_keys = ON')
        await expect(versionService.restore('v-ghost')).rejects.toMatchObject({
          code: 'FILE_NOT_FOUND'
        })
    await expect(versionService.getVersionDiff('v-ghost')).rejects.toMatchObject({
      code: 'FILE_NOT_FOUND'
    })

    // 全部失败分支都不动文件（验收③ 无原子性漏洞）
    const disk = await parseWordFile(imp.file.path)
    expect(disk.text).toContain('错误分支改写。')
  })

  it('回溯清理同文件 pending（§5 supersede 同构）：失真 pending 被丢弃、绝不写入', async () => {
    const imp = await importDocx('pending.docx', ['回溯前段落'])
    const { trustService, versionService } = buildStack()

    await trustService.persistPending(
      makeChangeSet('cs-1', [textChange('c1', 0, '回溯前段落', '第一次改写')]),
      imp.file.id,
      null
    )
    await trustService.accept('cs-1')
    const v1 = versionAt(currentVersionIdOf(imp.file.id))

    await trustService.persistPending(
      makeChangeSet('cs-2', [textChange('c2', 0, '第一次改写', '第二次改写')]),
      imp.file.id,
      null
    )
    await trustService.accept('cs-2')

    // 落一个未确认 pending（其 before/after 在回溯后将失真）
    await trustService.persistPending(
      makeChangeSet('cs-stale', [textChange('c3', 0, '第二次改写', '永远不会写入的文本')]),
      imp.file.id,
      null
    )
    expect(service.changeSets.listPending()).toHaveLength(1)

    await versionService.restore(v1.id)

    // 失真 pending 按 §5 清理顺序丢弃；文件回到 v1 快照内容
    expect(service.getResolvedChangeSet('cs-stale')?.status).toBe('discarded')
    expect(service.changeSets.listPending()).toHaveLength(0)
    const disk = await parseWordFile(imp.file.path)
    expect(disk.text).toContain('第一次改写')
    expect(disk.text).not.toContain('第二次改写')
    expect(disk.text).not.toContain('永远不会写入的文本')
  })

  it('崩溃恢复：孤儿快照与残留 .tmp 被清理（cleanedSnapshots），被引用快照保留', async () => {
    const imp = await importDocx('orphan.docx', ['孤儿快照测试段落'])
    const { trustService } = buildStack()

    await trustService.persistPending(
      makeChangeSet('cs-1', [textChange('c1', 0, '孤儿快照测试段落', '孤儿快照测试段落·改')]),
      imp.file.id,
      null
    )
    await trustService.accept('cs-1')
    const v1 = versionAt(currentVersionIdOf(imp.file.id))

    // 模拟崩溃残骸：无 versions 行引用的孤儿快照 + copyFileAtomicSync 写一半的 .tmp
    writeFileSync(join(snapshotsDir, 'orphan.snapshot.docx'), 'orphan')
    writeFileSync(join(snapshotsDir, 'half.snapshot.docx.tmp'), 'half')

    const result = service.runRecovery()
    expect(result.cleanedSnapshots).toBe(2)
    expect(existsSync(join(snapshotsDir, 'orphan.snapshot.docx'))).toBe(false)
    expect(existsSync(join(snapshotsDir, 'half.snapshot.docx.tmp'))).toBe(false)
    // 被引用的快照完好，目录内只剩它
    expect(existsSync(v1.snapshotPath as string)).toBe(true)
    expect(readdirSync(snapshotsDir).filter((f) => f.endsWith(SNAPSHOT_SUFFIX))).toEqual([
      basename(v1.snapshotPath as string)
    ])
  })
})
