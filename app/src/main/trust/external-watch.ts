import { randomUUID } from 'node:crypto'
import { statSync, watch, type FSWatcher, type Stats } from 'node:fs'
import type { AtomicChange } from '../../shared/agent'
import type { FileRecord } from '../../shared/db-protocol'
import type { WordParseResult } from '../../shared/file-protocol'
import type { ExternalDetectionView } from '../../shared/ipc'
import { computeParagraphDiff } from '../../shared/paragraph-diff'
import { createLogger } from '../logger'
import type { TrustDbPort, TrustFilePort, TrustVersionPort } from './trust-service'

// 外部编辑感知服务（T-S2-05A 第 2 层，PRD 2A.6 / 架构 §2A.6、§5.1）。
//
// 职责（勿删）：
// - 检出：启动扫描 + fs.watch(recursive) 去抖重扫。两级比对——mtime 预筛
//   （含 2s 写入间隙余量，规避应用自身写入的误报）→ word.parse contentHash
//   权威比对（哈希基于解析正文，语义是"应用内认知的基线"，§2A.6）。
// - mtime 前移但哈希一致（另存/复制未改内容、导入副本 mtime 晚于源文件
//   基线）：静默重定基线 mtime/size，不产生任何版本记录。
// - 冲突消解：哈希不一致即检出，该文件 pending ChangeSet 全部置 stale
//   （before/after 已失真），countByFileStatus 供 UI 提示失效数量——含历史
//   已处理行，重启后仍可追溯。
// - 三选项（PRD 2A.6：外部改动绝不静默覆盖）：
//   · 采纳 acceptExternal：ChangeSet(source=external, 出生即 applied) +
//     Version(author='external') + 基线推进（架构 §5.1「单一事实源」——
//     外部采纳与 AI/手动变更走同一张账本，三种来源均可追溯）；
//   · 忽略 ignoreExternal：仅推进基线（contentHash/size/mtime），不产生
//     版本与变更记录——"用户看过且放弃"不是内容事件；
//   · 查看 diff getExternalDiff：当前版本快照（旧文）vs 磁盘（新文）。
// - 崩溃顺序（acceptExternal）：①审计行 → ②版本快照 → ③基线推进。
//   ②③之间崩溃会因基线哈希未推进而被下次扫描重新检出、重放收敛（多出
//   一对语义收敛的审计行）；反序会出现"基线已推进但无版本"的谎报——
//   那才是不可恢复的原子性漏洞。
// - fs.watch 不可用（平台限制/目录异常）：warn 降级为启动扫描 + 渲染层
//   手动扫描按钮，功能不缺失只是实时性下降。
//
// 可测试性：与 TrustService 同一约定——结构化端口注入，不 import Electron；
// ExternalWatchError(code) 由 IPC 复用 toTrustError 包装（§3.1 错误规范化）。

const log = createLogger('external-watch')

// mtime 预筛余量：accept/restore 用 Date.now() 落基线，文件引擎 .tmp→rename
// 完成时刻的 mtime 可能晚于该值——预筛必须放行这类"自身写入"，再交给
// contentHash 权威比对兜底，否则每次 accept 后首轮扫描必然误报。
const MTIME_SLACK_MS = 2000

// fs.watch 去抖：Word 保存/复制会触发连续多次事件，攒 1s 后一次重扫。
const WATCH_DEBOUNCE_MS = 1000

export class ExternalWatchError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(`${code}: ${message}`)
  }
}

export interface ExternalWatchDeps {
  dbPort: TrustDbPort
  filePort: TrustFilePort
  versionPort: TrustVersionPort
  // 工作文件目录（导入副本所在地），fs.watch 递归监听根。
  filesDir: string
}

export interface ExternalAcceptPayload {
  versionId: string
  changeSetId: string
  contentHash: string
}

export class ExternalWatchService {
  private deps: ExternalWatchDeps
  // 检出状态（内存态）：fileId → 检出视图。重启后由启动扫描重建。
  private detections = new Map<string, ExternalDetectionView>()
  private watcher: FSWatcher | null = null
  private debounceTimer: NodeJS.Timeout | null = null
  // 扫描串行链：启动扫描、fs.watch 去抖重扫、手动扫描三者复用同一条链，
  // 任何时刻至多一轮扫描在跑；各调用方拿到各自的结果。
  private scanChain: Promise<unknown> = Promise.resolve()

  constructor(deps: ExternalWatchDeps) {
    this.deps = deps
  }

  // 全量扫描（串行）：遍历全部文件做外部编辑检出，返回当前检出清单。
  async scan(): Promise<ExternalDetectionView[]> {
    const run = this.scanChain.then(
      () => this.runScan(),
      () => this.runScan()
    )
    this.scanChain = run.catch(() => undefined)
    return run
  }

  private async runScan(): Promise<ExternalDetectionView[]> {
    const files = await this.deps.dbPort.request('file.listAll', undefined)
    for (const file of files) {
      await this.detectOne(file)
    }
    return this.listDetected()
  }

  // 单文件检出：mtime 预筛 → contentHash 权威比对。读盘/解析失败（文件被
  // Word 独占锁定、磁盘移除）只 warn 跳过，绝不让扫描循环崩掉。
  private async detectOne(file: FileRecord): Promise<void> {
    if (file.type !== 'word' || file.contentHash == null) return
    let stat: Stats
    try {
      stat = statSync(file.path)
    } catch {
      log.warn(
        { event: 'external-scan', fileId: file.id, path: file.path },
        '工作文件不可访问，跳过'
      )
      return
    }
    if (stat.mtimeMs <= file.modifiedAt + MTIME_SLACK_MS) return
    let parsed: WordParseResult
    try {
      parsed = await this.deps.filePort.request('word.parse', { sourcePath: file.path })
    } catch (err) {
      log.warn(
        {
          event: 'external-scan',
          fileId: file.id,
          err: err instanceof Error ? err.message : String(err)
        },
        '工作文件解析失败，跳过'
      )
      return
    }
    if (parsed.contentHash === file.contentHash) {
      // 内容一致仅 mtime 前移：静默重定基线 mtime/size，同时清掉可能存在的
      // 过期检出（用户在 Word 里把改动改回去了）。
      await this.deps.dbPort.request('file.update', {
        id: file.id,
        patch: { modifiedAt: stat.mtimeMs, size: stat.size }
      })
      this.detections.delete(file.id)
      return
    }
    // 哈希不一致 → 检出：pending 置 stale（显式失效，绝不静默覆盖）。
    await this.markPendingStale(file.id)
    const { count } = await this.deps.dbPort.request('changeSet.countByFileStatus', {
      fileId: file.id,
      status: 'stale'
    })
    this.detections.set(file.id, {
      fileId: file.id,
      fileName: file.name,
      diskModifiedAt: stat.mtimeMs,
      baselineModifiedAt: file.modifiedAt,
      stalePendingCount: count
    })
    log.info(
      { event: 'external-detected', fileId: file.id, stalePendingCount: count },
      'external edit detected'
    )
  }

  // 冲突消解：该文件的 pending ChangeSet 全部置 stale——其 before/after 已因
  // 基线漂移而失真，不能再 accept（§5.1 冲突消解）。
  private async markPendingStale(fileId: string): Promise<void> {
    const pending = await this.deps.dbPort.request('changeSet.listPending', undefined)
    for (const record of pending) {
      if (record.fileId === fileId) {
        await this.deps.dbPort.request('changeSet.updateStatus', {
          id: record.id,
          status: 'stale'
        })
        log.info(
          { event: 'pending-stale', changeSetId: record.id, fileId },
          'pending changeset marked stale by external edit'
        )
      }
    }
  }

  listDetected(): ExternalDetectionView[] {
    return Array.from(this.detections.values())
  }

  // 外部改动 diff 预览：before=当前版本快照（应用认知的旧文），after=磁盘
  // 新文（外部改动），渲染语义与 ChangeSetCard 一致（删红=基线里被改掉的，
  // 增绿=外部写入的）。
  async getExternalDiff(fileId: string): Promise<AtomicChange[]> {
    const file = await this.requireFile(fileId)
    const baseline = await this.baselineParagraphs(file)
    const disk = await this.deps.filePort.request('word.parseParagraphs', {
      sourcePath: file.path
    })
    return computeParagraphDiff(baseline, disk.paragraphs)
  }

  private async requireFile(fileId: string): Promise<FileRecord> {
    const file = await this.deps.dbPort.request('file.get', { id: fileId })
    if (!file) {
      throw new ExternalWatchError('FILE_NOT_FOUND', `文件 ${fileId} 不存在`)
    }
    return file
  }

  // 基线段落：当前版本的后像快照。无版本（从未 accept 过任何变更）的文件
  // 没有 diff 基准——抛错让 UI 收起 diff 入口，采纳/忽略仍可用。
  private async baselineParagraphs(file: FileRecord): Promise<string[]> {
    if (!file.currentVersionId) {
      throw new ExternalWatchError(
        'EXTERNAL_DIFF_NO_BASELINE',
        '该文件尚无版本基线，暂无 diff 可看（可直接采纳或忽略）'
      )
    }
    const version = await this.deps.dbPort.request('version.get', {
      id: file.currentVersionId
    })
    if (!version?.snapshotPath) {
      throw new ExternalWatchError(
        'EXTERNAL_DIFF_NO_BASELINE',
        '当前版本缺少快照文件，暂无 diff 可看'
      )
    }
    const parsed = await this.deps.filePort.request('word.parseParagraphs', {
      sourcePath: version.snapshotPath
    })
    return parsed.paragraphs
  }

  // 采纳外部改动：审计 → 版本 → 基线推进（崩溃顺序见文件头注释）。无版本
  // 的文件（导入后从未 accept）changes 为空数组——版本照常建立（快照=磁盘
  // 现状），摘要诚实记 0/0 项，不虚构变更。
  async acceptExternal(fileId: string): Promise<ExternalAcceptPayload> {
    const file = await this.requireFile(fileId)
    const { parsed, stat } = await this.reverifyDirty(file)
    let changes: AtomicChange[] = []
    if (file.currentVersionId) {
      const baseline = await this.baselineParagraphs(file)
      const disk = await this.deps.filePort.request('word.parseParagraphs', {
        sourcePath: file.path
      })
      changes = computeParagraphDiff(baseline, disk.paragraphs)
    }
    // ① 审计：外部采纳进 change_sets 账本（source=external，出生即 applied）。
    const changeSetId = randomUUID()
    await this.deps.dbPort.request('changeSet.create', {
      id: changeSetId,
      fileId: file.id,
      source: 'external',
      sourceCommand: '外部编辑采纳',
      status: 'applied',
      changes,
      changesPath: null,
      remoteId: null,
      etag: null,
      syncState: 'local',
      updatedBy: 'user'
    })
    // ② 版本：快照=磁盘新文，author='external'，与 AI/手动变更同链路可回退。
    const versionId = await this.deps.versionPort.onApplied({
      fileId: file.id,
      filePath: file.path,
      changeSetId,
      sourceCommand: '外部编辑采纳',
      source: 'external',
      contentHash: parsed.contentHash,
      parentVersionId: file.currentVersionId,
      appliedCount: changes.length,
      totalCount: changes.length
    })
    // ③ 基线推进（崩溃窗口分析见文件头）。
    await this.deps.dbPort.request('file.update', {
      id: file.id,
      patch: {
        contentHash: parsed.contentHash,
        size: stat.size,
        modifiedAt: stat.mtimeMs
      }
    })
    this.detections.delete(fileId)
    log.info(
      {
        event: 'external-accept',
        fileId: file.id,
        versionId,
        changeSetId,
        changes: changes.length
      },
      'external change accepted as new baseline'
    )
    return { versionId, changeSetId, contentHash: parsed.contentHash }
  }

  // 忽略外部改动：仅推进基线（contentHash/size/mtime），不产生版本与变更
  // 记录——"用户看过且放弃"不是内容事件，账本保持干净。后续再改仍可检出。
  async ignoreExternal(fileId: string): Promise<string> {
    const file = await this.requireFile(fileId)
    const { parsed, stat } = await this.reverifyDirty(file)
    await this.deps.dbPort.request('file.update', {
      id: file.id,
      patch: {
        contentHash: parsed.contentHash,
        size: stat.size,
        modifiedAt: stat.mtimeMs
      }
    })
    this.detections.delete(fileId)
    log.info(
      { event: 'external-ignore', fileId: file.id },
      'external change ignored, baseline rebased'
    )
    return parsed.contentHash
  }

  // 处置前复检：以 contentHash 为准（内存检出态可能过期——用户可能已通过
  // 版本回退把文件改回基线）。磁盘现状与基线一致 → EXTERNAL_NOT_DETECTED。
  private async reverifyDirty(
    file: FileRecord
  ): Promise<{ parsed: WordParseResult; stat: Stats }> {
    let stat: Stats
    try {
      stat = statSync(file.path)
    } catch {
      throw new ExternalWatchError('FILE_NOT_FOUND', '工作文件已不可访问')
    }
    const parsed = await this.deps.filePort.request('word.parse', { sourcePath: file.path })
    if (file.contentHash && parsed.contentHash === file.contentHash) {
      throw new ExternalWatchError(
        'EXTERNAL_NOT_DETECTED',
        '文件内容与基线一致，无需处理'
      )
    }
    return { parsed, stat }
  }

  // fs.watch 递归监听工作文件目录：事件去抖后重扫（重扫内含 mtime 预筛 +
  // contentHash 权威比对，自身写入不会误报）。平台不支持/目录异常 → warn 降级。
  startWatching(): void {
    if (this.watcher) return
    try {
      this.watcher = watch(this.deps.filesDir, { recursive: true }, () =>
        this.scheduleRescan()
      )
      this.watcher.on('error', (err) => {
        log.warn(
          {
            event: 'external-watch',
            err: err instanceof Error ? err.message : String(err)
          },
          'fs.watch error, degrade to manual scan'
        )
        this.stopWatching()
      })
      log.info({ event: 'external-watch' }, 'fs.watch started')
    } catch (err) {
      log.warn(
        {
          event: 'external-watch',
          err: err instanceof Error ? err.message : String(err)
        },
        'fs.watch unavailable, degrade to manual scan'
      )
      this.watcher = null
    }
  }

  stopWatching(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    this.watcher?.close()
    this.watcher = null
  }

  private scheduleRescan(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      void this.scan().catch((err) => {
        log.warn(
          {
            event: 'external-watch',
            err: err instanceof Error ? err.message : String(err)
          },
          'debounced rescan failed'
        )
      })
    }, WATCH_DEBOUNCE_MS)
  }
}
