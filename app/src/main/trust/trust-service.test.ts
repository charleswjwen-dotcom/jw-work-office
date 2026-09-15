import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type DbHandle } from '../db/connection'
import { DataService } from '../db/data-service'
import { CHANGES_EXTERNAL_THRESHOLD } from '../db/recovery'
import type {
  ChangeSetRecord,
  DbRequestMap,
  DbRequestType,
  FileRecord
} from '../../shared/db-protocol'
import type { FileRequestMap, FileRequestType } from '../../shared/file-protocol'
import type { AtomicChange, ChangeSet } from '../../shared/agent'
import { parseWordFile } from '../files/word-parser'
import { applyParagraphEdits } from '../files/word-writer'
import { makeDocx } from '../files/__fixtures__/make-docx'
import { importWordFile } from '../import/import-service'
import { LlmGateway } from '../llm/gateway'
import { UsageMeter } from '../llm/usage-meter'
import { MockChatProvider } from '../llm/mock-provider'
import { ToolRegistry } from '../tools/registry'
import { createReplaceTextTool } from '../tools/replace-text-tool'
import { DocumentSession } from '../agent/document-session'
import { AgentService } from '../agent/agent-service'
import { TrustService } from './trust-service'

// T-S2-05 信任流集成测试：真实 SQLite + 真实 mammoth/JSZip + MockChatProvider，
// 跑通「Agent 产出 pending → 落库（含 supersede）→ diff 预览数据 → 用户分支
// （全部接受 / 部分接受 / 拒绝）」全链路，直击任务验收标准：
// - accept 后文件实际变更且结构完整（段落写入器直改 OOXML）；
// - partial 只写勾选项，其余段落原样；
// - reject 后文件字节不变、无 .tmp / 外置 .changeset 残留（§5 清理顺序）；
// - 外置 changes（>512KB）先删文件再删 DB 行（§9.1 一致性）；
// - 落库后磁盘被外部修改 → BASELINE_MISMATCH 拒写（§2A.6 外部编辑感知）。

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
      throw new Error(`unexpected file request in test: ${type}`)
    }
  }
}

function buildStack() {
  const session = new DocumentSession({ dbClient: dbAdapter(), fileClient: fileAdapter() })
  const gateway = new LlmGateway(new MockChatProvider(), { usage: new UsageMeter('mock') })
  const registry = new ToolRegistry()
  registry.register(createReplaceTextTool(session.resolveParagraph))
  const trustService = new TrustService({ dbPort: dbAdapter(), filePort: fileAdapter() })
  const agentService = new AgentService({ gateway, registry, session, trust: trustService })
  return { agentService, trustService }
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

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'mwo-trust-'))
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

describe('TrustService 信任流（T-S2-05 验收）', () => {
  it('全链路：对话产出 pending 落库 → 全部接受 → 文件实际变更、基线刷新、无 .tmp 残留', async () => {
    const imp = await importDocx('report.docx', ['公司季度报告草稿：营收增长缓慢，需要改进。'])
    const { agentService, trustService } = buildStack()

    const turn = await agentService.runTurn({
      fileId: imp.file.id,
      prompt: '把"缓慢"替换成"强劲"'
    })
    expect(turn.ok).toBe(true)
    expect(turn.changeSets[0]?.status).toBe('pending')

    // diff 预览数据源（渲染层卡片消费的正是这份视图）
    const views = await trustService.listPendingViews()
    expect(views).toHaveLength(1)
    const view = views[0]
    expect(view.id).toBe(turn.changeSets[0]?.id)
    expect(view.fileId).toBe(imp.file.id)
    expect(view.fileName).toBe('report.docx')
    expect(view.sourceCommand).toBe('把"缓慢"替换成"强劲"')
    expect(view.status).toBe('pending')
    expect(view.changes[0]?.before?.text).toBe('公司季度报告草稿：营收增长缓慢，需要改进。')
    expect(view.changes[0]?.after?.text).toBe('公司季度报告草稿：营收增长强劲，需要改进。')

    // 接受前红线：磁盘原文未被静默改动
    const preDisk = await parseWordFile(imp.file.path)
    expect(preDisk.text).toContain('缓慢')

    // 全部接受（省略 acceptedChangeIds）
    const result = await trustService.accept(view.id)
    expect(result.ok).toBe(true)
    expect(result.status).toBe('applied')
    expect(result.appliedCount).toBe(1)
    expect(result.contentHash).toBeTruthy()

    // 文件实际变更
    const disk = await parseWordFile(imp.file.path)
    expect(disk.text).toContain('强劲')
    expect(disk.text).not.toContain('缓慢')
    expect(disk.contentHash).toBe(result.contentHash)

    // 基线刷新（§2A.6）：files.content_hash 与写后重解析哈希一致
    const file = service.files.get(imp.file.id)
    expect(file?.contentHash).toBe(result.contentHash)

    // 状态终态化 + pending 清空
    expect(service.getResolvedChangeSet(view.id)?.status).toBe('applied')
    expect(await trustService.listPendingViews()).toEqual([])

    // 原子写无 .tmp 残留（§5.1）
    expect(readdirSync(workDir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('部分接受：仅勾选项写入，未勾选段落原样，文档结构完整，状态 partial', async () => {
    const imp = await importDocx('multi.docx', ['第一段：甲', '第二段：乙', '第三段：丙'])
    const { trustService } = buildStack()

    await trustService.persistPending(
      makeChangeSet('cs-partial', [
        textChange('c1', 0, '第一段：甲', '第一段：甲改'),
        textChange('c2', 1, '第二段：乙', '第二段：乙改'),
        textChange('c3', 2, '第三段：丙', '第三段：丙改')
      ]),
      imp.file.id,
      null
    )

    const result = await trustService.accept('cs-partial', ['c1', 'c3'])
    expect(result.ok).toBe(true)
    expect(result.status).toBe('partial')
    expect(result.appliedCount).toBe(2)

    const disk = await parseWordFile(imp.file.path)
    expect(disk.text).toContain('第一段：甲改')
    expect(disk.text).toContain('第三段：丙改')
    expect(disk.text).toContain('第二段：乙')
    expect(disk.text).not.toContain('第二段：乙改')
    // 结构完整（验收标准：部分接受后文档结构完整）
    expect(disk.meta.paragraphCount).toBe(3)

    expect(service.getResolvedChangeSet('cs-partial')?.status).toBe('partial')
    expect(await trustService.listPendingViews()).toEqual([])
  })

  it('拒绝：文件字节不变、状态 discarded、pending 清空', async () => {
    const imp = await importDocx('reject.docx', ['内容保持原样'])
    const { trustService } = buildStack()

    await trustService.persistPending(
      makeChangeSet('cs-reject', [textChange('c1', 0, '内容保持原样', '内容被改掉')]),
      imp.file.id,
      null
    )

    const bytesBefore = readFileSync(imp.file.path)

    const result = await trustService.reject('cs-reject')
    expect(result).toEqual({ ok: true, status: 'discarded' })

    // 验收标准：拒绝后文件不变（逐字节比对）
    expect(readFileSync(imp.file.path).equals(bytesBefore)).toBe(true)
    expect(service.getResolvedChangeSet('cs-reject')?.status).toBe('discarded')
    expect(await trustService.listPendingViews()).toEqual([])
  })

  it('外置 changes（>512KB）：resolve 回读完整、reject 先删外置文件再删 DB 行（§9.1 一致性）', async () => {
    const imp = await importDocx('external.docx', ['外置变更集测试段落'])
    const { trustService } = buildStack()

    // 序列化后超过 512KB 阈值 → DataService 外置为 .changeset 文件（§4）
    const big = 'x'.repeat(CHANGES_EXTERNAL_THRESHOLD + 1024)
    const record = await trustService.persistPending(
      makeChangeSet('cs-ext', [textChange('c1', 0, '外置变更集测试段落', big)]),
      imp.file.id,
      null
    )
    expect(record.changesPath).toBeTruthy()
    expect(existsSync(record.changesPath as string)).toBe(true)

    // DB 行内 changes 置空、路径指向外置
    const stored = service.changeSets.get('cs-ext')
    expect(stored?.changes).toBeNull()
    expect(stored?.changesPath).toBe(record.changesPath)

    // resolve 回读：外置内容完整回到渲染层视图（diff 预览数据不因外置而失真）
    const views = await trustService.listPendingViews()
    expect(views[0]?.changes[0]?.after?.text).toBe(big)

    // reject：外置文件先被清理，DB 行终态化——不留孤儿文件（§9.1）
    await trustService.reject('cs-ext')
    expect(existsSync(record.changesPath as string)).toBe(false)
    expect(service.changeSets.get('cs-ext')?.status).toBe('discarded')
    expect(readdirSync(workDir).filter((f) => f.endsWith('.changeset'))).toEqual([])
  })

  it('supersede：同文件新 pending 顶掉旧 pending（外置文件同步清理）', async () => {
    const imp = await importDocx('super.docx', ['同文件顶替测试段落'])
    const { trustService } = buildStack()

    const first = await trustService.persistPending(
      makeChangeSet('cs-old', [
        textChange('c1', 0, '同文件顶替测试段落', 'y'.repeat(CHANGES_EXTERNAL_THRESHOLD + 1024))
      ]),
      imp.file.id,
      null
    )
    expect(first.changesPath).toBeTruthy()

    await trustService.persistPending(
      makeChangeSet('cs-new', [textChange('c2', 0, '同文件顶替测试段落', '同文件顶替测试段落·新')]),
      imp.file.id,
      null
    )

    // 单文件单 pending（§5）：只剩新的
    const pending = service.changeSets.listPending()
    expect(pending.map((r) => r.id)).toEqual(['cs-new'])
    expect(service.changeSets.get('cs-old')?.status).toBe('discarded')
    expect(existsSync(first.changesPath as string)).toBe(false)
  })

  it('BASELINE_MISMATCH：落库后磁盘被外部修改 → 拒绝写入、ChangeSet 保持 pending', async () => {
    const imp = await importDocx('base.docx', ['基线一致性测试段落'])
    const { trustService } = buildStack()

    await trustService.persistPending(
      makeChangeSet('cs-base', [textChange('c1', 0, '基线一致性测试段落', '被外部编辑污染')]),
      imp.file.id,
      null
    )

    // 模拟外部编辑：落库后磁盘内容被替换（§2A.6 外部编辑感知）
    writeFileSync(imp.file.path, await makeDocx(['外部编辑后的不同内容']))

    await expect(trustService.accept('cs-base')).rejects.toMatchObject({
      code: 'BASELINE_MISMATCH'
    })

    // 信任流未写入（磁盘仍是外部编辑后的内容，而非 ChangeSet 的 after）
    const disk = await parseWordFile(imp.file.path)
    expect(disk.text).toContain('外部编辑后的不同内容')
    expect(disk.text).not.toContain('被外部编辑污染')

    // 失败路径不动状态：ChangeSet 保持 pending，可等用户重新决策
    expect(service.getResolvedChangeSet('cs-base')?.status).toBe('pending')
  })

  it('错误分支：CHANGESET_NOT_FOUND / TRUST_NO_SELECTION / UNSUPPORTED_CHANGE_TYPE', async () => {
    const { trustService } = buildStack()

    await expect(trustService.accept('no-such-cs')).rejects.toMatchObject({
      code: 'CHANGESET_NOT_FOUND'
    })
    await expect(trustService.reject('no-such-cs')).rejects.toMatchObject({
      code: 'CHANGESET_NOT_FOUND'
    })

    const imp = await importDocx('err.docx', ['错误分支测试段落'])

    // 空勾选
    await trustService.persistPending(
      makeChangeSet('cs-empty', [textChange('c1', 0, '错误分支测试段落', '空勾选')]),
      imp.file.id,
      null
    )
    await expect(trustService.accept('cs-empty', [])).rejects.toMatchObject({
      code: 'TRUST_NO_SELECTION'
    })

    // 暂不支持的变更类型（heading/style 不在 T-S2-05 写入口径内）
    await trustService.persistPending(
      makeChangeSet('cs-style', [
        {
          id: 'c-style',
          location: { type: 'heading', text: '错误分支测试段落' },
          kind: 'style',
          before: { text: '错误分支测试段落' },
          after: { text: '错误分支测试段落' }
        }
      ]),
      imp.file.id,
      null
    )
    await expect(trustService.accept('cs-style')).rejects.toMatchObject({
      code: 'UNSUPPORTED_CHANGE_TYPE'
    })

    // 两条失败分支都不动文件
    const disk = await parseWordFile(imp.file.path)
    expect(disk.text).toContain('错误分支测试段落')
  })
})
