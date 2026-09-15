import { and, desc, eq, isNotNull } from 'drizzle-orm'
import type {
  ChangeSetRecord,
  ConversationRecord,
  FileRecord,
  MessageRecord,
  VersionRecord
} from '../../shared/db-protocol'
import type { Db } from './connection'
import { changeSets, conversations, files, messages, versions, workspaces } from './schema'

type FileRow = typeof files.$inferSelect
type VersionRow = typeof versions.$inferSelect
type ChangeSetRow = typeof changeSets.$inferSelect
type ConversationRow = typeof conversations.$inferSelect
type MessageRow = typeof messages.$inferSelect

function toFileRecord(row: FileRow): FileRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    type: row.type,
    path: row.path,
    size: row.size,
    pageCount: row.pageCount,
    sheetCount: row.sheetCount,
    tags: (row.tags as string[] | null) ?? null,
    thumbnail: row.thumbnail,
    currentVersionId: row.currentVersionId,
    contentHash: row.contentHash,
    importedAt: row.importedAt.getTime(),
    modifiedAt: row.modifiedAt.getTime(),
    remoteId: row.remoteId,
    etag: row.etag,
    syncState: row.syncState,
    updatedBy: row.updatedBy
  }
}

function toVersionRecord(row: VersionRow): VersionRecord {
  return {
    id: row.id,
    fileId: row.fileId,
    seq: row.seq,
    createdAt: row.createdAt.getTime(),
    triggerCommand: row.triggerCommand,
    author: row.author,
    changeSummary: row.changeSummary,
    storageType: row.storageType,
    snapshotPath: row.snapshotPath,
    changeSetId: row.changeSetId,
    parentVersionId: row.parentVersionId,
    remoteId: row.remoteId,
    etag: row.etag,
    syncState: row.syncState,
    updatedBy: row.updatedBy
  }
}

function toChangeSetRecord(row: ChangeSetRow): ChangeSetRecord {
  return {
    id: row.id,
    fileId: row.fileId,
    source: row.source,
    sourceCommand: row.sourceCommand,
    status: row.status,
    changes: row.changes ?? null,
    changesPath: row.changesPath,
    remoteId: row.remoteId,
    etag: row.etag,
    syncState: row.syncState,
    updatedBy: row.updatedBy
  }
}

function toConversationRecord(row: ConversationRow): ConversationRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    title: row.title,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime()
  }
}

function toMessageRecord(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    conversationId: row.conversationId,
    role: row.role,
    content: row.content,
    toolCalls: row.toolCalls ?? null,
    changeSetId: row.changeSetId,
    resultCards: row.resultCards ?? null,
    createdAt: row.createdAt.getTime()
  }
}

export class WorkspaceRepository {
  constructor(private readonly db: Db) {}

  // 幂等确保工作区存在：导入前必须先有 workspace 行，否则 files.workspace_id
  // 的外键约束（connection.ts 开启了 foreign_keys=ON）会直接拒绝插入。
  ensure(id: string, name: string): { id: string } {
    this.db
      .insert(workspaces)
      .values({ id, name })
      .onConflictDoNothing({ target: workspaces.id })
      .run()
    return { id }
  }
}

export class FileRepository {
  constructor(private readonly db: Db) {}

  create(record: FileRecord): FileRecord {
    const row = this.db
      .insert(files)
      .values({
        id: record.id,
        workspaceId: record.workspaceId,
        name: record.name,
        type: record.type,
        path: record.path,
        size: record.size,
        pageCount: record.pageCount,
        sheetCount: record.sheetCount,
        tags: record.tags,
        thumbnail: record.thumbnail,
        currentVersionId: record.currentVersionId,
        contentHash: record.contentHash,
        importedAt: new Date(record.importedAt),
        modifiedAt: new Date(record.modifiedAt),
        remoteId: record.remoteId,
        etag: record.etag,
        syncState: record.syncState ?? 'local',
        updatedBy: record.updatedBy
      })
      .returning()
      .get()
    return toFileRecord(row)
  }

  get(id: string): FileRecord | null {
    const row = this.db.select().from(files).where(eq(files.id, id)).get()
    return row ? toFileRecord(row) : null
  }

  listByWorkspace(workspaceId: string, type?: FileRecord['type']): FileRecord[] {
    const where = type
      ? and(eq(files.workspaceId, workspaceId), eq(files.type, type))
      : eq(files.workspaceId, workspaceId)
    return this.db.select().from(files).where(where).all().map(toFileRecord)
  }

  update(id: string, patch: Partial<FileRecord>): FileRecord | null {
    const values: Partial<FileRow> = {}
    if (patch.name !== undefined) values.name = patch.name
    if (patch.path !== undefined) values.path = patch.path
    if (patch.size !== undefined) values.size = patch.size
    if (patch.pageCount !== undefined) values.pageCount = patch.pageCount
    if (patch.sheetCount !== undefined) values.sheetCount = patch.sheetCount
    if (patch.tags !== undefined) values.tags = patch.tags
    if (patch.thumbnail !== undefined) values.thumbnail = patch.thumbnail
    if (patch.currentVersionId !== undefined)
      values.currentVersionId = patch.currentVersionId
    if (patch.contentHash !== undefined) values.contentHash = patch.contentHash
    if (patch.modifiedAt !== undefined) values.modifiedAt = new Date(patch.modifiedAt)
    if (patch.remoteId !== undefined) values.remoteId = patch.remoteId
    if (patch.etag !== undefined) values.etag = patch.etag
    if (patch.syncState !== undefined) values.syncState = patch.syncState
    if (patch.updatedBy !== undefined) values.updatedBy = patch.updatedBy
    if (Object.keys(values).length === 0) return this.get(id)
    const row = this.db
      .update(files)
      .set(values)
      .where(eq(files.id, id))
      .returning()
      .get()
    return row ? toFileRecord(row) : null
  }

  delete(id: string): number {
    const result = this.db.delete(files).where(eq(files.id, id)).run()
    return result.changes
  }
}

export class VersionRepository {
  constructor(private readonly db: Db) {}

  create(record: VersionRecord): VersionRecord {
    const row = this.db
      .insert(versions)
      .values({
        id: record.id,
        fileId: record.fileId,
        seq: record.seq,
        createdAt: new Date(record.createdAt),
        triggerCommand: record.triggerCommand,
        author: record.author,
        changeSummary: record.changeSummary,
        storageType: record.storageType,
        snapshotPath: record.snapshotPath,
        changeSetId: record.changeSetId,
        parentVersionId: record.parentVersionId,
        remoteId: record.remoteId,
        etag: record.etag,
        syncState: record.syncState ?? 'local',
        updatedBy: record.updatedBy
      })
      .returning()
      .get()
    return toVersionRecord(row)
  }

  listByFile(fileId: string): VersionRecord[] {
    return this.db
      .select()
      .from(versions)
      .where(eq(versions.fileId, fileId))
      .orderBy(desc(versions.seq))
      .all()
      .map(toVersionRecord)
  }

  // T-S2-06 线性回溯：按 id 取单个版本（快照路径、seq、parent 链）。
  get(id: string): VersionRecord | null {
    const row = this.db.select().from(versions).where(eq(versions.id, id)).get()
    return row ? toVersionRecord(row) : null
  }

  // T-S2-06 崩溃恢复：全部被 versions 行引用的快照绝对路径——
  // 孤儿快照判定基准（snapshots 目录中不在此集合内的即可清理）。
  listSnapshotPaths(): string[] {
    return this.db
      .select({ snapshotPath: versions.snapshotPath })
      .from(versions)
      .where(isNotNull(versions.snapshotPath))
      .all()
      .map((row) => row.snapshotPath)
      .filter((p): p is string => p !== null)
  }
}

export class ChangeSetRepository {
  constructor(private readonly db: Db) {}

  create(record: ChangeSetRecord): ChangeSetRecord {
    const row = this.db
      .insert(changeSets)
      .values({
        id: record.id,
        fileId: record.fileId,
        source: record.source,
        sourceCommand: record.sourceCommand,
        status: record.status,
        changes: record.changes,
        changesPath: record.changesPath,
        remoteId: record.remoteId,
        etag: record.etag,
        syncState: record.syncState ?? 'local',
        updatedBy: record.updatedBy
      })
      .returning()
      .get()
    return toChangeSetRecord(row)
  }

  get(id: string): ChangeSetRecord | null {
    const row = this.db.select().from(changeSets).where(eq(changeSets.id, id)).get()
    return row ? toChangeSetRecord(row) : null
  }

  listPending(): ChangeSetRecord[] {
    return this.db
      .select()
      .from(changeSets)
      .where(eq(changeSets.status, 'pending'))
      .all()
      .map(toChangeSetRecord)
  }

  updateStatus(id: string, status: ChangeSetRecord['status']): ChangeSetRecord | null {
    const row = this.db
      .update(changeSets)
      .set({ status })
      .where(eq(changeSets.id, id))
      .returning()
      .get()
    return row ? toChangeSetRecord(row) : null
  }
}

export class ConversationRepository {
  constructor(private readonly db: Db) {}

  create(record: ConversationRecord): ConversationRecord {
    const row = this.db
      .insert(conversations)
      .values({
        id: record.id,
        workspaceId: record.workspaceId,
        title: record.title,
        createdAt: new Date(record.createdAt),
        updatedAt: new Date(record.updatedAt)
      })
      .returning()
      .get()
    return toConversationRecord(row)
  }

  createMessage(record: MessageRecord): MessageRecord {
    const row = this.db
      .insert(messages)
      .values({
        id: record.id,
        conversationId: record.conversationId,
        role: record.role,
        content: record.content,
        toolCalls: record.toolCalls,
        changeSetId: record.changeSetId,
        resultCards: record.resultCards,
        createdAt: new Date(record.createdAt)
      })
      .returning()
      .get()
    return toMessageRecord(row)
  }

  listMessages(conversationId: string): MessageRecord[] {
    return this.db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .all()
      .map(toMessageRecord)
  }
}
