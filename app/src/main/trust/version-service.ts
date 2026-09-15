import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { AtomicChange } from '../../shared/agent'
import type { ChangeSetRecord, FileRecord, VersionRecord } from '../../shared/db-protocol'
import type { VersionView } from '../../shared/ipc'
import { computeParagraphDiff } from '../../shared/paragraph-diff'
import { createLogger } from '../logger'
import type { TrustDbPort, TrustFilePort, TrustVersionAppliedInput } from './trust-service'

// 版本服务（T-S2-06，架构 §5 快照数据流 / PRD 3.3「线性回溯」的主进程执行点）。
//
// 职责（勿删）：
// - onApplied：accept 写入成功后的后像快照（copy 工作文件 → snapshots/ →
//   version.create → 移 currentVersionId 指针）。§5 7A.3 顺序：快照写成功
//   才移指针——崩溃窗口最多"文件已新、指针未动"，重放可收敛。
// - listVersionViews：渲染层版本历史数据源（seq 降序 + isCurrent 标记）。
// - getVersionDiff：当前工作文件 → 目标快照的段落级 diff 预览。
// - restore：回溯 = 原子替换工作文件 + 反向 ChangeSet（出生即 applied）+
//   回溯自身也生成后像快照（可再回溯，验收标准②）。
//
// 可测试性：与 TrustService 同一约定——结构化端口注入，不 import Electron，
// VersionFlowError(code) 由 IPC 复用 toTrustError 包装（§3.1 错误规范化）。

const log = createLogger('version-service')

// 快照文件命名约定：snapshots/{versionId}.snapshot.docx。
// recovery.ts 的孤儿清理按同一后缀枚举（那边用字面量，避免 db→trust 反向依赖）。
export const SNAPSHOT_SUFFIX = '.snapshot.docx'

export class VersionFlowError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(`${code}: ${message}`)
  }
}

export interface VersionServiceDeps {
  dbPort: TrustDbPort
  filePort: TrustFilePort
  snapshotsDir: string
}

export interface VersionDiffPayload {
  versionId: string
  seq: number
  changes: AtomicChange[]
}

export interface RestorePayload {
  versionId: string
  changeSetId: string
  appliedCount: number
  contentHash: string
}

export class VersionService {
  private deps: VersionServiceDeps

  constructor(deps: VersionServiceDeps) {
    this.deps = deps
  }

  // 后像快照（§5 快照数据流）：写入成功的工作文件整体复制进 snapshots 目录，
  // 再落 versions 行、移 currentVersionId 指针。快照是"这一刻文件内容"的
  // 字节级事实，回溯以它为准而非按 ChangeSet 反演（T-S0-04 结论③）。
  async onApplied(input: TrustVersionAppliedInput): Promise<string> {
    const versionId = randomUUID()
    const snapshotPath = join(this.deps.snapshotsDir, `${versionId}${SNAPSHOT_SUFFIX}`)
    await this.deps.filePort.request('file.copy', {
      sourcePath: input.filePath,
      destPath: snapshotPath
    })
    const versions = await this.deps.dbPort.request('version.listByFile', {
      fileId: input.fileId
    })
    const seq = (versions[0]?.seq ?? 0) + 1
    // T-S2-05A 来源映射（架构 §5.1）：manual→author 'user'、external→author
    // 'external'、ai（缺省）→ 'ai'；中文摘要按来源措辞；updatedBy 区分 agent
    // 写入与用户侧动作。快照/seq/指针移动对来源不敏感——「手动优化同样进
    // 版本快照可回退」是 T-S2-05A 验收标准。
    const source = input.source ?? 'ai'
    const author: VersionRecord['author'] =
      source === 'manual' ? 'user' : source === 'external' ? 'external' : 'ai'
    const changeSummary =
      source === 'manual'
        ? `手动修改 ${input.appliedCount}/${input.totalCount} 项`
        : source === 'external'
          ? `外部编辑 ${input.appliedCount}/${input.totalCount} 项`
          : `AI 修改 ${input.appliedCount}/${input.totalCount} 项`
    const record: VersionRecord = {
      id: versionId,
      fileId: input.fileId,
      seq,
      createdAt: Date.now(),
      triggerCommand: input.sourceCommand,
      author,
      changeSummary,
      storageType: 'full',
      snapshotPath,
      changeSetId: input.changeSetId,
      parentVersionId: input.parentVersionId,
      remoteId: null,
      etag: null,
      syncState: 'local',
      updatedBy: source === 'ai' ? 'agent' : 'user'
    }
    await this.deps.dbPort.request('version.create', record)
    // §5 7A.3：快照与 versions 行都已成功，才允许移动 currentVersionId 指针。
    await this.deps.dbPort.request('file.update', {
      id: input.fileId,
      patch: { currentVersionId: versionId }
    })
    log.info(
      {
        event: 'version-snapshot',
        versionId,
        fileId: input.fileId,
        seq,
        changeSetId: input.changeSetId
      },
      'post-image snapshot created'
    )
    return versionId
  }

  async listVersionViews(fileId: string): Promise<VersionView[]> {
    const file = await this.deps.dbPort.request('file.get', { id: fileId })
    if (!file) return []
    const records = await this.deps.dbPort.request('version.listByFile', { fileId })
    return records.map((r) => ({
      id: r.id,
      fileId: r.fileId,
      seq: r.seq,
      createdAt: r.createdAt,
      author: r.author,
      triggerCommand: r.triggerCommand,
      changeSummary: r.changeSummary,
      isCurrent: r.id === file.currentVersionId
    }))
  }

  // 公共前置：版本存在、快照在位、文件健在。snapshotPath 单独返回，
  // 绕开 TS 属性 narrowing 不传导到整体对象返回值的问题。
  private async requireSnapshot(
    versionId: string
  ): Promise<{ version: VersionRecord; file: FileRecord; snapshotPath: string }> {
    const version = await this.deps.dbPort.request('version.get', { id: versionId })
    if (!version) {
      throw new VersionFlowError('VERSION_NOT_FOUND', `版本 ${versionId} 不存在`)
    }
    const snapshotPath = version.snapshotPath
    if (!snapshotPath) {
      throw new VersionFlowError('SNAPSHOT_MISSING', `版本 v${version.seq} 无快照文件`)
    }
    const file = await this.deps.dbPort.request('file.get', { id: version.fileId })
    if (!file) {
      throw new VersionFlowError('FILE_NOT_FOUND', `文件 ${version.fileId} 已不存在`)
    }
    return { version, file, snapshotPath }
  }

  // diff 预览：当前工作文件 → 目标快照（before=现在，after=恢复后），
  // 渲染语义与 ChangeSetCard 一致（删红=即将移除的现在，增绿=恢复回来的内容）。
  async getVersionDiff(versionId: string): Promise<VersionDiffPayload> {
    const { version, file, snapshotPath } = await this.requireSnapshot(versionId)
    const current = await this.deps.filePort.request('word.parseParagraphs', {
      sourcePath: file.path
    })
    const target = await this.deps.filePort.request('word.parseParagraphs', {
      sourcePath: snapshotPath
    })
    const changes = computeParagraphDiff(current.paragraphs, target.paragraphs)
    return { versionId: version.id, seq: version.seq, changes }
  }

  // 线性回溯（PRD 3.3）：原子替换工作文件 + 反向 ChangeSet + 回溯自身的后像快照。
  async restore(versionId: string): Promise<RestorePayload> {
    const { version, file, snapshotPath } = await this.requireSnapshot(versionId)
    if (file.currentVersionId === version.id) {
      throw new VersionFlowError('ALREADY_CURRENT', `版本 v${version.seq} 即当前版本，无需恢复`)
    }
    const current = await this.deps.filePort.request('word.parseParagraphs', {
      sourcePath: file.path
    })
    const target = await this.deps.filePort.request('word.parseParagraphs', {
      sourcePath: snapshotPath
    })
    const changes = computeParagraphDiff(current.paragraphs, target.paragraphs)

    // 回溯使既有 pending 失真（其 before/after 已不成立）：先按 §5 清理顺序
    // 丢弃同文件 pending（与 persistPending 的 supersede 同构）。
    const pending = await this.deps.dbPort.request('changeSet.listPending', undefined)
    for (const old of pending) {
      if (old.fileId === file.id) {
        await this.deps.dbPort.request('changeSet.discard', { id: old.id })
        log.info(
          { event: 'restore-supersede', oldId: old.id, fileId: file.id },
          'superseded stale pending changeset'
        )
      }
    }

    // 原子替换先于记账：崩溃窗口最多"文件已恢复但无记录"（用户可再点一次
    // 回溯补救）；反序会出现"记录已写、文件未换"的谎报——那才是不可恢复的
    // 原子性漏洞（验收标准③ 无原子性漏洞）。
    const restored = await this.deps.filePort.request('file.copy', {
      sourcePath: snapshotPath,
      destPath: file.path
    })
    const parsed = await this.deps.filePort.request('word.parse', { sourcePath: file.path })

    // 反向 ChangeSet（§5：回退生成反向记录）：出生即 applied，可审计"谁在何时
    // 恢复到哪版"。走 DataService.createChangeSet 路由——超 512KB 自动外置。
    const changeSetId = randomUUID()
    const reverse: ChangeSetRecord = {
      id: changeSetId,
      fileId: file.id,
      source: 'manual',
      sourceCommand: `恢复到版本 v${version.seq}`,
      status: 'applied',
      changes,
      changesPath: null,
      remoteId: null,
      etag: null,
      syncState: 'local',
      updatedBy: 'user'
    }
    await this.deps.dbPort.request('changeSet.create', reverse)

    // 回溯自身的后像快照：不与目标版本共享快照文件——孤儿清理按 versions
    // 行引用判定，共享会让两个 version 行指同一文件、删一误一。
    const newVersionId = randomUUID()
    const newSnapshotPath = join(this.deps.snapshotsDir, `${newVersionId}${SNAPSHOT_SUFFIX}`)
    await this.deps.filePort.request('file.copy', {
      sourcePath: file.path,
      destPath: newSnapshotPath
    })
    const versions = await this.deps.dbPort.request('version.listByFile', { fileId: file.id })
    const seq = (versions[0]?.seq ?? 0) + 1
    const newVersion: VersionRecord = {
      id: newVersionId,
      fileId: file.id,
      seq,
      createdAt: Date.now(),
      triggerCommand: `恢复到版本 v${version.seq}`,
      author: 'user',
      changeSummary: `回溯至版本 v${version.seq}`,
      storageType: 'full',
      snapshotPath: newSnapshotPath,
      changeSetId,
      parentVersionId: file.currentVersionId,
      remoteId: null,
      etag: null,
      syncState: 'local',
      updatedBy: 'user'
    }
    await this.deps.dbPort.request('version.create', newVersion)
    await this.deps.dbPort.request('file.update', {
      id: file.id,
      patch: {
        currentVersionId: newVersionId,
        contentHash: parsed.contentHash,
        size: restored.byteSize,
        modifiedAt: Date.now()
      }
    })
    log.info(
      {
        event: 'version-restore',
        fileId: file.id,
        fromVersionId: file.currentVersionId,
        toVersionId: version.id,
        newVersionId,
        changeSetId,
        changes: changes.length
      },
      'version restored'
    )
    return {
      versionId: newVersionId,
      changeSetId,
      appliedCount: changes.length,
      contentHash: parsed.contentHash
    }
  }
}
