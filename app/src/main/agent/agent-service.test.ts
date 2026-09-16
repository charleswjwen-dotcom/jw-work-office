import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
import { parseWordFile, splitParagraphs } from '../files/word-parser'
import { applyParagraphEdits } from '../files/word-writer'
import { makeDocx } from '../files/__fixtures__/make-docx'
import { importWordFile } from '../import/import-service'
import { LlmGateway } from '../llm/gateway'
import { UsageMeter } from '../llm/usage-meter'
import { MockChatProvider } from '../llm/mock-provider'
import { ToolRegistry } from '../tools/registry'
import { createReplaceTextTool } from '../tools/replace-text-tool'
import { TrustService } from '../trust/trust-service'
import { SNAPSHOT_SUFFIX, VersionService } from '../trust/version-service'
import { DocumentSession } from './document-session'
import { AgentService } from './agent-service'
import type { AgentToolEvent } from './agent'

// T-S2-04 集成测试：真实 SQLite + 真实 mammoth + MockChatProvider，
// 跑通「载文档 → 建上下文（隐私红线）→ Agent 循环 → pending ChangeSet」全链路。
// 验收标准「LLM 调用 ReplaceTextTool 后返回 ChangeSet 不静默改文件」在此落断言：
// 工具产出 pending，且轮次结束后磁盘原文必须未被改动。
// S2 质量门禁①「最小可信闭环」（导入→对话→ChangeSet→diff→确认→快照→回溯）
// 也在本文件收口：buildStack 与主进程 index.ts 同一装配（VersionService →
// TrustService → AgentService(trust)），闭环测试直击门禁验收行。

let workDir: string
let snapshotsDir: string
let handle: DbHandle
let service: DataService
let parseCount = 0

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
        case 'file.listByWorkspace': {
          const p = payload as { workspaceId: string }
          return service.files.listByWorkspace(p.workspaceId) as never
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
        parseCount += 1
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
  // 与主进程 index.ts 同一装配链：VersionService（后像快照）→ TrustService →
  // AgentService（trust 注入后 runTurn 自动落库 pending，§5 第 2 步）。
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
  const session = new DocumentSession({ dbClient: dbAdapter(), fileClient: fileAdapter() })
  const gateway = new LlmGateway(new MockChatProvider(), { usage: new UsageMeter('mock') })
  const registry = new ToolRegistry()
  registry.register(createReplaceTextTool(session.resolveParagraph))
  const agentService = new AgentService({ gateway, registry, session, trust: trustService })
  return { agentService, trustService, versionService }
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

function fileRecord(overrides: Partial<FileRecord> & Pick<FileRecord, 'id' | 'type'>): FileRecord {
  return {
    workspaceId: WS,
    name: 'record.docx',
    path: join(workDir, 'record.docx'),
    size: 100,
    pageCount: null,
    sheetCount: null,
    tags: null,
    thumbnail: null,
    currentVersionId: null,
    contentHash: null,
    importedAt: Date.now(),
    modifiedAt: Date.now(),
    remoteId: null,
    etag: null,
    syncState: null,
    updatedBy: null,
    ...overrides
  }
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'mwo-agent-'))
  snapshotsDir = join(workDir, 'snapshots')
  mkdirSync(snapshotsDir)
  handle = openDatabase(join(workDir, 'test.db'))
  service = new DataService({
    handle,
    dirs: { tmpDir: join(workDir, 'tmp'), changesetDir: workDir, snapshotsDir }
  })
  service.workspaces.ensure(WS, 'Test WS')
  parseCount = 0
})

afterEach(() => {
  service.close()
  rmSync(workDir, { recursive: true, force: true })
})

describe('AgentService integration（T-S2-04 验收）', () => {
  it('一句话替换：返回 pending ChangeSet，不静默改文件', async () => {
    const imp = await importDocx('report.docx', ['公司季度报告草稿：营收增长缓慢，需要改进。'])
    const { agentService } = buildStack()

    const result = await agentService.runTurn({
      fileId: imp.file.id,
      prompt: '把"缓慢"替换成"强劲"'
    })

    expect(result.ok).toBe(true)
    expect(result.changeSets).toHaveLength(1)

    const cs = result.changeSets[0]
    expect(cs.toolName).toBe('replaceText')
    expect(cs.status).toBe('pending')
    expect(cs.error).toBeUndefined()
    expect(cs.changes[0].before?.text).toBe('公司季度报告草稿：营收增长缓慢，需要改进。')
    expect(cs.changes[0].after?.text).toBe('公司季度报告草稿：营收增长强劲，需要改进。')

    expect(result.finalMessage).toBe('已根据工具返回的 ChangeSet 完成处理，等待用户确认。')

    // 红线审计：只发节选段落，总量有界
    expect(result.context.selected).toEqual([0])
    expect(result.context.totalDocChars).toBeGreaterThan(0)
    expect(result.context.sentChars).toBeLessThanOrEqual(2000)

    // 用量按轮结算（mock 无精确上报 → 估算回退，但 calls 精确）
    expect(result.usage.provider).toBe('mock')
    expect(result.usage.calls).toBe(2)
    expect(result.usage.tokensIn).toBeGreaterThan(0)
    expect(result.usage.tokensOut).toBeGreaterThan(0)

    // 验收核心：ChangeSet 恒 pending，磁盘原文未被改动
    const disk = await parseWordFile(imp.file.path)
    expect(disk.text).toContain('缓慢')
    expect(disk.text).not.toContain('强劲')
  })

  it('T-S2-08③ 流式透传：token 渐进流出，工具起止事件按 callId 配对', async () => {
    const imp = await importDocx('stream.docx', ['公司季度报告草稿：营收增长缓慢，需要改进。'])
    const { agentService } = buildStack()

    const tokens: string[] = []
    const toolEvents: AgentToolEvent[] = []
    const result = await agentService.runTurn({
      fileId: imp.file.id,
      prompt: '把"缓慢"替换成"强劲"',
      onToken: (t) => tokens.push(t),
      onToolEvent: (ev) => toolEvents.push(ev)
    })

    expect(result.ok).toBe(true)
    // Mock 两步循环：第一步工具轮（content 空，不流 token，只发工具事件），
    // 第二步总结轮（content 按小包流出）——token 拼接后与终值一致。
    expect(tokens.length).toBeGreaterThan(1)
    expect(tokens.join('')).toBe(result.finalMessage)

    // 工具事件起止配对：start → end(ok)，callId 与 LlmToolCall.id 对齐
    expect(toolEvents).toHaveLength(2)
    expect(toolEvents[0]).toMatchObject({ kind: 'tool-start', toolName: 'replaceText' })
    expect(toolEvents[1]).toMatchObject({ kind: 'tool-end', toolName: 'replaceText', ok: true })
    // 联合类型先用 kind 判别式窄化，再访问 tool-end 独有的 error 字段
    const endEvent = toolEvents[1]
    if (endEvent.kind !== 'tool-end') {
      throw new Error('第二个工具事件应为 tool-end')
    }
    expect(endEvent.callId).toBe(toolEvents[0].callId)
    expect(endEvent.error).toBeUndefined()
  })

  it('未知文件：ok:false + FILE_NOT_FOUND，不产生 LLM 用量', async () => {
    const { agentService } = buildStack()

    const result = await agentService.runTurn({
      fileId: 'no-such-file',
      prompt: '把"a"替换成"b"'
    })

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('FILE_NOT_FOUND')
    expect(result.changeSets).toEqual([])
    expect(result.usage.calls).toBe(0)
    expect(result.usage.provider).toBe('mock')
  })

  it('非 Word 文件：UNSUPPORTED_FILE_TYPE（Excel/PPT 对话属 T-S3）', async () => {
    const { agentService } = buildStack()
    service.files.create(
      fileRecord({ id: 'file-excel-1', type: 'excel', name: 'book.xlsx' })
    )

    const result = await agentService.runTurn({
      fileId: 'file-excel-1',
      prompt: '把"a"替换成"b"'
    })

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('UNSUPPORTED_FILE_TYPE')
  })

  it('磁盘文件缺失：WORD_PARSE_FAILED（结构化降级，不抛给渲染层）', async () => {
    const { agentService } = buildStack()
    service.files.create(
      fileRecord({ id: 'file-ghost-1', type: 'word', name: 'ghost.docx' })
    )

    const result = await agentService.runTurn({
      fileId: 'file-ghost-1',
      prompt: '把"a"替换成"b"'
    })

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('WORD_PARSE_FAILED')
    expect(result.error?.message).toContain('文档解析失败')
  })

  it('DocumentSession 缓存：同文件第二轮命中 contentHash，不重复解析', async () => {
    const imp = await importDocx('cache.docx', ['第一段：稳定内容', '第二段：背景说明'])
    const { agentService } = buildStack()

    expect(parseCount).toBe(1)

    const first = await agentService.runTurn({
      fileId: imp.file.id,
      prompt: '把"稳定"替换成"变动"'
    })
    expect(first.ok).toBe(true)
    expect(first.changeSets[0]?.status).toBe('pending')
    expect(first.changeSets[0]?.changes[0]?.after?.text).toBe('第一段：变动内容')
    expect(parseCount).toBe(2)

    // 第二轮：缓存命中（contentHash 未变），word.parse 不再触发
    const second = await agentService.runTurn({
      fileId: imp.file.id,
      prompt: '把"说明"替换成"描述"'
    })
    expect(parseCount).toBe(2)
    expect(second.ok).toBe(true)
    // Mock 固定操作 index 0（不含"说明"）→ 错误 ChangeSet，属可恢复路径
    expect(second.changeSets[0]?.error?.code).toBe('TEXT_NOT_FOUND')
    expect(second.usage.calls).toBe(2)
  })

  it('S2 门禁① 最小可信闭环：导入→对话→ChangeSet→diff→确认→快照→回溯', async () => {
    const imp = await importDocx('loop.docx', ['公司季度报告草稿：营收增长缓慢，需要改进。'])
    const { agentService, trustService, versionService } = buildStack()

    // 对话：一句话替换 → pending ChangeSet 经编排层自动落库（§5 第 2 步）
    const turn = await agentService.runTurn({
      fileId: imp.file.id,
      prompt: '把"缓慢"替换成"强劲"'
    })
    expect(turn.ok).toBe(true)
    expect(turn.changeSets[0]?.status).toBe('pending')

    // ChangeSet：落库事实以 DB 为准（与渲染层卡片同源）
    const views = await trustService.listPendingViews()
    expect(views).toHaveLength(1)
    const view = views[0]
    expect(view.fileId).toBe(imp.file.id)
    expect(view.fileName).toBe('loop.docx')
    expect(view.source).toBe('ai')
    expect(view.sourceCommand).toBe('把"缓慢"替换成"强劲"')

    // diff：before/after 段级对照；确认前磁盘原文必须未动
    expect(view.changes).toHaveLength(1)
    expect(view.changes[0].before?.text).toBe('公司季度报告草稿：营收增长缓慢，需要改进。')
    expect(view.changes[0].after?.text).toBe('公司季度报告草稿：营收增长强劲，需要改进。')
    expect((await parseWordFile(imp.file.path)).text).toContain('缓慢')

    // 确认：accept 确定性改写 + 刷新基线（contentHash/size）
    const applied = await trustService.accept(view.id)
    expect(applied.ok).toBe(true)
    expect(applied.status).toBe('applied')
    expect(applied.appliedCount).toBe(1)
    const afterDisk = await parseWordFile(imp.file.path)
    expect(afterDisk.text).toContain('强劲')
    expect(afterDisk.text).not.toContain('缓慢')

    // 快照：accept 触发后像快照 v1（§5 7A.3：快照写成功才移 currentVersionId）
    const v1Id = service.files.get(imp.file.id)?.currentVersionId
    expect(v1Id).toBeTruthy()
    const v1 = service.versions.get(v1Id as string)
    expect(v1).toMatchObject({
      author: 'ai',
      changeSummary: 'AI 修改 1/1 项',
      changeSetId: view.id
    })
    expect(v1?.snapshotPath).toBe(join(snapshotsDir, `${v1?.id}${SNAPSHOT_SUFFIX}`))
    expect(existsSync(v1?.snapshotPath as string)).toBe(true)

    // 第二轮修改 → v2，制造"回溯目标 ≠ 当前版本"的前置
    const turn2 = await agentService.runTurn({
      fileId: imp.file.id,
      prompt: '把"需要"替换成"必须"'
    })
    expect(turn2.ok).toBe(true)
    const views2 = await trustService.listPendingViews()
    expect(views2).toHaveLength(1)
    const applied2 = await trustService.accept(views2[0].id)
    expect(applied2.ok).toBe(true)
    const v2Id = service.files.get(imp.file.id)?.currentVersionId
    expect(v2Id).not.toBe(v1Id)

    // 回溯前 diff 预览：现在（必须）→ 恢复后（需要），渲染语义与卡片一致
    const diff = await versionService.getVersionDiff(v1Id as string)
    expect(diff.changes).toHaveLength(1)
    expect(diff.changes[0].before?.text).toContain('必须')
    expect(diff.changes[0].after?.text).toContain('需要')

    // 回溯：v1 快照整文件原子替换 + 反向 ChangeSet（出生即 applied）+ 回溯自身的 v3 快照
    const restored = await versionService.restore(v1Id as string)
    expect(restored.appliedCount).toBe(1)
    const restoredDisk = await parseWordFile(imp.file.path)
    expect(restoredDisk.text).toContain('需要')
    expect(restoredDisk.text).not.toContain('必须')
    // 与 v1 后像快照逐字节一致（回溯以快照字节为准，T-S0-04 结论③）
    expect(readFileSync(imp.file.path)).toEqual(readFileSync(v1?.snapshotPath as string))

    const reverse = service.getResolvedChangeSet(restored.changeSetId)
    expect(reverse).toMatchObject({
      status: 'applied',
      source: 'manual',
      sourceCommand: '恢复到版本 v1'
    })
    const v3 = service.versions.get(restored.versionId)
    expect(v3).toMatchObject({
      changeSummary: '回溯至版本 v1',
      parentVersionId: v2Id
    })
    expect(service.files.get(imp.file.id)?.currentVersionId).toBe(restored.versionId)
    expect(service.versions.listByFile(imp.file.id)).toHaveLength(3)
  })
})
