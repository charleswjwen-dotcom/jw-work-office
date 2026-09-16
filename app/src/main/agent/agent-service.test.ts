import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type DbHandle } from '../db/connection'
import { DataService } from '../db/data-service'
import type { DbRequestMap, DbRequestType, FileRecord } from '../../shared/db-protocol'
import type { FileRequestMap, FileRequestType } from '../../shared/file-protocol'
import { parseWordFile } from '../files/word-parser'
import { makeDocx } from '../files/__fixtures__/make-docx'
import { importWordFile } from '../import/import-service'
import { LlmGateway } from '../llm/gateway'
import { UsageMeter } from '../llm/usage-meter'
import { MockChatProvider } from '../llm/mock-provider'
import { ToolRegistry } from '../tools/registry'
import { createReplaceTextTool } from '../tools/replace-text-tool'
import { DocumentSession } from './document-session'
import { AgentService } from './agent-service'
import type { AgentToolEvent } from './agent'

// T-S2-04 集成测试：真实 SQLite + 真实 mammoth + MockChatProvider，
// 跑通「载文档 → 建上下文（隐私红线）→ Agent 循环 → pending ChangeSet」全链路。
// 验收标准「LLM 调用 ReplaceTextTool 后返回 ChangeSet 不静默改文件」在此落断言：
// 工具产出 pending，且轮次结束后磁盘原文必须未被改动。

let workDir: string
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
        parseCount += 1
        const p = payload as { sourcePath: string }
        return (await parseWordFile(p.sourcePath)) as never
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
  const agentService = new AgentService({ gateway, registry, session })
  return { agentService }
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
  handle = openDatabase(join(workDir, 'test.db'))
  service = new DataService({
    handle,
    dirs: { tmpDir: join(workDir, 'tmp'), changesetDir: workDir }
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
})
