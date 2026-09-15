import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChangeSetRecord } from '../../shared/db-protocol'
import { atomicWriteFileSync, safeUnlink } from './atomic-write'
import type { DbHandle } from './connection'
import { CHANGES_EXTERNAL_THRESHOLD, runCrashRecovery, type RecoveryDirs } from './recovery'
import {
  ChangeSetRepository,
  ConversationRepository,
  FileRepository,
  VersionRepository,
  WorkspaceRepository
} from './repositories'
import { SqliteFtsSearchRepository, type SearchRepository } from './search-repository'

export interface DataServiceOptions {
  handle: DbHandle
  dirs: RecoveryDirs
}

export class DataService {
  readonly workspaces: WorkspaceRepository
  readonly files: FileRepository
  readonly versions: VersionRepository
  readonly changeSets: ChangeSetRepository
  readonly conversations: ConversationRepository
  readonly search: SearchRepository

  private readonly handle: DbHandle
  private readonly dirs: RecoveryDirs

  constructor({ handle, dirs }: DataServiceOptions) {
    this.handle = handle
    this.dirs = dirs
    this.workspaces = new WorkspaceRepository(handle.db)
    this.files = new FileRepository(handle.db)
    this.versions = new VersionRepository(handle.db)
    this.changeSets = new ChangeSetRepository(handle.db)
    this.conversations = new ConversationRepository(handle.db)
    this.search = new SqliteFtsSearchRepository(handle.raw)
  }

  createChangeSet(record: ChangeSetRecord): ChangeSetRecord {
    const serialized = record.changes == null ? '' : JSON.stringify(record.changes)
    const overThreshold = Buffer.byteLength(serialized, 'utf-8') > CHANGES_EXTERNAL_THRESHOLD
    if (overThreshold) {
      const path = join(this.dirs.changesetDir, `${record.id}.changeset`)
      atomicWriteFileSync(path, serialized)
      return this.changeSets.create({ ...record, changes: null, changesPath: path })
    }
    return this.changeSets.create(record)
  }

  readChangeSetChanges(record: ChangeSetRecord): unknown {
    if (record.changesPath && existsSync(record.changesPath)) {
      return JSON.parse(readFileSync(record.changesPath, 'utf-8'))
    }
    return record.changes ?? null
  }

  // T-S2-05 信任交互：resolve 后读取（外置 changes 时从 .changeset 文件解析回填）。
  // 外置文件丢失（被外部删除）时 changes 落回 null，由上层判定为不可应用。
  getResolvedChangeSet(id: string): ChangeSetRecord | null {
    const record = this.changeSets.get(id)
    if (!record) return null
    if (record.changesPath) {
      return { ...record, changes: this.readChangeSetChanges(record) }
    }
    return record
  }

  listPendingResolved(): ChangeSetRecord[] {
    return this.changeSets
      .listPending()
      .map((record) =>
        record.changesPath ? { ...record, changes: this.readChangeSetChanges(record) } : record
      )
  }

  discardChangeSet(id: string): ChangeSetRecord | null {
    const cs = this.changeSets.get(id)
    if (!cs) return null
    if (cs.changesPath) safeUnlink(cs.changesPath)
    return this.changeSets.updateStatus(id, 'discarded')
  }

  runRecovery() {
    return runCrashRecovery(this.changeSets, this.dirs)
  }

  close(): void {
    this.handle.close()
  }
}
