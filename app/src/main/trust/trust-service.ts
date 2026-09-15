import { randomUUID } from 'node:crypto'
import type { AtomicChange, ChangeSet } from '../../shared/agent'
import type { ChangeSetRecord } from '../../shared/db-protocol'
import type { DbRequestMap, DbRequestType } from '../../shared/db-protocol'
import type { FileRequestMap, FileRequestType } from '../../shared/file-protocol'
import type { ChangeSetView, TrustApplyResult, TrustRejectResult } from '../../shared/ipc'
import { createLogger } from '../logger'

// 信任交互服务（T-S2-05，架构 §5 信任交互数据流的主进程侧执行点）。
//
// 职责（勿删）：
// - persistPending：Agent 轮产出的 pending ChangeSet 落库（§5 第 2 步）。同一文件
//   任一时刻只允许一个 pending——新 pending 落库前先 supersede 旧 pending（按
//   §5 清理顺序丢弃，不留孤儿外置文件）。
// - accept：用户确认后（全部/部分）→ 基线校验（§2A.6 外部编辑感知）→
//   word.applyParagraphEdits 确定性改写（文件引擎进程）→ 刷新 files.content_hash
//   基线 → 状态终态化 applied/partial。写入失败（对齐不一致、文件损坏）时
//   ChangeSet 保持 pending、文件保持原样——不存在"半应用"状态。
// - reject：用户拒绝 → changeSet.discard（先删外置 changes 文件、再删 DB 行，
//   §5 清理顺序）→ 文件不变。
// - T-S2-05A createManualPending：应用内手动微调（PRD 2A.6 第 1 层）——全量
//   段落文本输入 → 仅含差异的 kind=text 变更 → source=manual 的标准 pending
//   ChangeSet，accept/快照/回溯与 AI 变更同链路（架构 §5.1「单一事实源」）。
// - T-S2-06 后像快照钩子：accept 写入成功后调 version.onApplied 生成版本快照
//   （§5 7A.3：快照写成功才移 currentVersionId 指针），失败则整轮 accept 抛错、
//   状态保持 pending——重放会因 expectedBefore 不一致被文件引擎拦截。
//
// 可测试性设计（与 AgentService 同一约定）：
// - 依赖是结构化端口接口（request 方法签名与 DbClient/FileClient 完全一致），
//   主进程直接注入真实 client，vitest（node 环境）注入纯适配器——
//   TrustService 本身不 import 任何 Electron API。
// - 业务失败不静默：所有错误以 TrustFlowError(code) 抛出，由 IPC handler 统一
//   包装为 { ok:false, error } 结构化响应（§3.1 IPC 错误规范化）。

const log = createLogger('trust-service')

// 结构化端口：与 DbClient.request / FileClient.request 签名完全一致。
export interface TrustDbPort {
  request<T extends DbRequestType>(
    type: T,
    payload: DbRequestMap[T]['request']
  ): Promise<DbRequestMap[T]['response']>
}

export interface TrustFilePort {
  request<T extends FileRequestType>(
    type: T,
    payload: FileRequestMap[T]['request']
  ): Promise<FileRequestMap[T]['response']>
}

// T-S2-06 版本事件端口：accept 写入成功后由 VersionService 实现（生成后像快照）。
// 定义在消费方（trust-service）、实现在 version-service——单向 import，无环。
export interface TrustVersionAppliedInput {
  fileId: string
  filePath: string
  changeSetId: string
  sourceCommand: string | null
  // T-S2-05A 变更来源：VersionService 按此映射 versions.author 与中文摘要
  // （manual→'user'、external→'external'）；缺省按 'ai'，既有调用方兼容。
  source?: 'ai' | 'manual' | 'external'
  contentHash: string
  parentVersionId: string | null
  appliedCount: number
  totalCount: number
}

export interface TrustVersionPort {
  // 返回新建版本 id（T-S2-05A：外部采纳结果回传，渲染层可联动版本历史）。
  onApplied(input: TrustVersionAppliedInput): Promise<string>
}

export interface TrustServiceDeps {
  dbPort: TrustDbPort
  filePort: TrustFilePort
  version?: TrustVersionPort
}

export class TrustFlowError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(`${code}: ${message}`)
  }
}

function parseAtomicChanges(record: ChangeSetRecord): AtomicChange[] {
  const changes = record.changes
  if (!Array.isArray(changes)) {
    throw new TrustFlowError('CHANGESET_CORRUPT', 'ChangeSet 内容缺失或损坏（外置文件可能已丢失）')
  }
  return changes as AtomicChange[]
}

export class TrustService {
  private deps: TrustServiceDeps

  constructor(deps: TrustServiceDeps) {
    this.deps = deps
  }

  // Agent 轮结束后调用：把 pending ChangeSet 落入 change_sets 表（§5 第 2 步）。
  // 错误降级 ChangeSet（status='discarded'）不落库——它只是本轮错误的结构化回执。
  async persistPending(
    changeSet: ChangeSet,
    fileId: string,
    sourceCommand: string | null,
    // T-S2-05A：变更来源（ai=Agent 轮、manual=应用内微调）；external 采纳
    // 出生即 applied，不经此方法。缺省 'ai' 保持既有调用方兼容。
    source: 'ai' | 'manual' | 'external' = 'ai'
  ): Promise<ChangeSetRecord> {
    if (changeSet.status !== 'pending') {
      throw new TrustFlowError(
        'CHANGESET_NOT_PENDING',
        `仅 pending 状态可落库，当前为 ${changeSet.status}`
      )
    }
    // 单文件单 pending 约束（架构 §5）：新 ChangeSet 顶掉同文件的旧 pending。
    // 旧 pending 按 §5 清理顺序丢弃（先删外置文件再删 DB 行）。
    const existing = await this.deps.dbPort.request('changeSet.listPending', undefined)
    for (const old of existing) {
      if (old.fileId === fileId) {
        await this.deps.dbPort.request('changeSet.discard', { id: old.id })
        log.info({ event: 'trust-supersede', oldId: old.id, fileId }, 'superseded stale pending changeset')
      }
    }
    const record: ChangeSetRecord = {
      id: changeSet.id,
      fileId,
      source,
      sourceCommand,
      status: 'pending',
      changes: changeSet.changes,
      changesPath: null,
      remoteId: null,
      etag: null,
      syncState: 'local',
      updatedBy: source === 'ai' ? 'agent' : 'user'
    }
    return this.deps.dbPort.request('changeSet.create', record)
  }

  // T-S2-05A 第 1 层：应用内手动微调（PRD 2A.6）。输入=编辑器全量段落文本
  // （UI 按当前段落渲染），输出=source=manual 的标准 pending ChangeSet——
  // accept/部分接受/快照/回溯与 AI 变更完全同链路（架构 §5.1「单一事实源」，
  // 无手动专用路径）。能力边界=word.applyParagraphEdits：只支持段内文本替换、
  // 段落数不可变；空段/含换行的段会被 splitParagraphs 过滤或拆分，导致落盘
  // 索引错位——一律拒绝（MANUAL_PARAGRAPH_INVALID），段落增删请走对话流程。
  async createManualPending(
    fileId: string,
    editedParagraphs: { index: number; text: string }[]
  ): Promise<{ changeSet: ChangeSetRecord | null; changeCount: number }> {
    const file = await this.deps.dbPort.request('file.get', { id: fileId })
    if (!file) {
      throw new TrustFlowError('FILE_NOT_FOUND', `文件 ${fileId} 不存在`)
    }
    // 基线校验：外部编辑未处理（磁盘已偏离基线）时拒绝——before 会失真，
    // 用户需先在检出横幅处理外部改动（采纳/忽略）再微调。
    const parsed = await this.deps.filePort.request('word.parse', { sourcePath: file.path })
    if (file.contentHash && parsed.contentHash !== file.contentHash) {
      throw new TrustFlowError(
        'BASELINE_MISMATCH',
        '文件已被外部修改，请先处理外部改动（采纳或忽略）再手动微调'
      )
    }
    const { paragraphs } = await this.deps.filePort.request('word.parseParagraphs', {
      sourcePath: file.path
    })
    if (editedParagraphs.length !== paragraphs.length) {
      throw new TrustFlowError(
        'MANUAL_PARAGRAPH_COUNT_MISMATCH',
        `段落数不匹配：文档 ${paragraphs.length} 段，提交 ${editedParagraphs.length} 段`
      )
    }
    const seen = new Set<number>()
    for (const p of editedParagraphs) {
      if (
        !Number.isInteger(p.index) ||
        p.index < 0 ||
        p.index >= paragraphs.length ||
        seen.has(p.index)
      ) {
        throw new TrustFlowError('MANUAL_PARAGRAPH_INVALID', `段落索引非法：${p.index}`)
      }
      seen.add(p.index)
      if (p.text.length === 0 || p.text.includes('\n')) {
        throw new TrustFlowError(
          'MANUAL_PARAGRAPH_INVALID',
          '段落不能为空、也不能包含换行（段落增删请走对话流程）'
        )
      }
    }
    // 只对有文本差异的段产出 kind=text 变更（before/after 齐备：渲染侧词级
    // 着色与 accept 的 expectedBefore 防线都依赖这两字段）。
    const changes: AtomicChange[] = []
    let seq = 0
    for (const p of editedParagraphs) {
      const before = paragraphs[p.index]
      if (before === p.text) continue
      changes.push({
        id: `mc-${String(++seq).padStart(3, '0')}`,
        location: { type: 'paragraph', index: p.index },
        kind: 'text',
        before: { text: before },
        after: { text: p.text },
        renderHint: 'inline'
      })
    }
    if (changes.length === 0) {
      return { changeSet: null, changeCount: 0 }
    }
    const changeSet: ChangeSet = {
      id: randomUUID(),
      toolName: 'manualEdit',
      status: 'pending',
      changes,
      createdAt: new Date().toISOString()
    }
    // persistPending 内含 supersede：手动微调顶掉同文件旧 pending（含 AI 的），
    // 单文件单 pending 约束对来源不敏感。
    const record = await this.persistPending(changeSet, fileId, null, 'manual')
    log.info(
      { event: 'manual-pending', fileId, changeSetId: record.id, changes: changes.length },
      'manual changeset created'
    )
    return { changeSet: record, changeCount: changes.length }
  }

  // 渲染层卡片数据源：pending ChangeSet（changes 已 resolve，含外置）+ 文件名合并。
  async listPendingViews(): Promise<ChangeSetView[]> {
    const records = await this.deps.dbPort.request('changeSet.listPendingResolved', undefined)
    const views: ChangeSetView[] = []
    for (const record of records) {
      const file = await this.deps.dbPort.request('file.get', { id: record.fileId })
      views.push({
        id: record.id,
        fileId: record.fileId,
        fileName: file?.name ?? '（文件已删除）',
        source: record.source,
        sourceCommand: record.sourceCommand,
        status: 'pending',
        changes: record.changes == null ? [] : (record.changes as AtomicChange[])
      })
    }
    return views
  }

  // accept 分支（§5）：全部接受（acceptedChangeIds 省略）或部分接受（传勾选的
  // AtomicChange.id 列表）。任何失败路径都不动文件、保持 pending。
  async accept(id: string, acceptedChangeIds?: string[]): Promise<TrustApplyResult> {
    const record = await this.deps.dbPort.request('changeSet.getResolved', { id })
    if (!record) {
      throw new TrustFlowError('CHANGESET_NOT_FOUND', `ChangeSet ${id} 不存在`)
    }
    if (record.status !== 'pending') {
      throw new TrustFlowError('CHANGESET_NOT_PENDING', `ChangeSet 已终态化：${record.status}`)
    }
    const changes = parseAtomicChanges(record)

    const selected =
      acceptedChangeIds === undefined
        ? changes
        : changes.filter((c) => acceptedChangeIds.includes(c.id))
    if (selected.length === 0) {
      throw new TrustFlowError('TRUST_NO_SELECTION', '未勾选任何变更项')
    }

    const file = await this.deps.dbPort.request('file.get', { id: record.fileId })
    if (!file) {
      throw new TrustFlowError('FILE_NOT_FOUND', `文件 ${record.fileId} 已不存在`)
    }

    // 基线校验（§2A.6 外部编辑感知）：落库基线与磁盘现状必须一致，否则本轮
    // ChangeSet 的 before/after 已失真，写入会错位——拒绝并要求用户重新发起。
    const parsed = await this.deps.filePort.request('word.parse', { sourcePath: file.path })
    if (file.contentHash && parsed.contentHash !== file.contentHash) {
      throw new TrustFlowError(
        'BASELINE_MISMATCH',
        '文件在 ChangeSet 产出后已被外部修改，请重新发起对话'
      )
    }

    // 编辑映射：AtomicChange → 文件引擎的段落编辑项（含 expectedBefore 段级防线）。
    const edits = selected.map((change) => {
      if (change.location.type !== 'paragraph' || change.kind !== 'text') {
        throw new TrustFlowError(
          'UNSUPPORTED_CHANGE_TYPE',
          `暂不支持 ${change.location.type}/${change.kind} 类型的写入`
        )
      }
      const before = change.before?.text
      const after = change.after?.text
      if (before === undefined || after === undefined) {
        throw new TrustFlowError('CHANGES_INVALID', '编辑项缺少 before/after 文本')
      }
      return { index: change.location.index, text: after, expectedBefore: before }
    })

    // 确定性改写（文件引擎 Utility 进程；内部含 expectedBefore 对齐校验 +
    // .tmp→fsync→rename 原子落盘，失败则文件保持原样）。
    const applied = await this.deps.filePort.request('word.applyParagraphEdits', {
      sourcePath: file.path,
      edits
    })

    // 写入成功：刷新基线（contentHash = 写后重解析哈希，§2A.6），再终态化状态。
    // 顺序先刷文件行后改状态：若中途崩溃，文件已新而 status 仍 pending——
    // 重放 accept 会因 expectedBefore 不匹配而失败告警，不会二次错写。
    await this.deps.dbPort.request('file.update', {
      id: file.id,
      patch: {
        contentHash: applied.contentHash,
        size: applied.byteSize,
        modifiedAt: Date.now()
      }
    })
    // T-S2-06 后像快照（§5 7A.3）：快照写成功才更新 current_version_id，
    // 因此钩子在状态终态化之前执行。失败让整轮 accept 抛错、状态保持
    // pending——文件已改写但无版本记录（灰区），重放 accept 会因
    // expectedBefore 对齐不一致被文件引擎拦截，不存在静默丢快照的二次写。
    if (this.deps.version) {
      await this.deps.version.onApplied({
        fileId: file.id,
        filePath: file.path,
        changeSetId: id,
        sourceCommand: record.sourceCommand,
        source: record.source,
        contentHash: applied.contentHash,
        parentVersionId: file.currentVersionId,
        appliedCount: selected.length,
        totalCount: changes.length
      })
    }
    const status = selected.length === changes.length ? 'applied' : 'partial'
    await this.deps.dbPort.request('changeSet.updateStatus', { id, status })

    log.info(
      { event: 'trust-accept', changeSetId: id, applied: selected.length, total: changes.length },
      'changeset applied'
    )
    return {
      ok: true,
      status,
      appliedCount: selected.length,
      contentHash: applied.contentHash
    }
  }

  // reject 分支（§5）：丢弃 ChangeSet 并清理外置 changes 文件（先删文件、后删
  // DB 行），文件内容不动。架构 §5 明确 reject ≠ updateStatus('discarded')。
  async reject(id: string): Promise<TrustRejectResult> {
    const record = await this.deps.dbPort.request('changeSet.getResolved', { id })
    if (!record) {
      throw new TrustFlowError('CHANGESET_NOT_FOUND', `ChangeSet ${id} 不存在`)
    }
    if (record.status !== 'pending') {
      throw new TrustFlowError('CHANGESET_NOT_PENDING', `ChangeSet 已终态化：${record.status}`)
    }
    await this.deps.dbPort.request('changeSet.discard', { id })
    log.info({ event: 'trust-reject', changeSetId: id }, 'changeset discarded')
    return { ok: true, status: 'discarded' }
  }
}
