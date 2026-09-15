export interface FileRecord {
  id: string
  workspaceId: string
  name: string
  type: 'word' | 'excel' | 'ppt'
  path: string
  size: number
  pageCount: number | null
  sheetCount: number | null
  tags: string[] | null
  thumbnail: string | null
  currentVersionId: string | null
  contentHash: string | null
  importedAt: number
  modifiedAt: number
  remoteId: string | null
  etag: string | null
  syncState: 'local' | 'synced' | 'dirty' | 'conflict' | null
  updatedBy: string | null
}

export interface VersionRecord {
  id: string
  fileId: string
  seq: number
  createdAt: number
  triggerCommand: string | null
  author: 'ai' | 'user' | 'external' | null
  changeSummary: string | null
  storageType: 'full' | 'diff'
  snapshotPath: string | null
  changeSetId: string | null
  parentVersionId: string | null
  remoteId: string | null
  etag: string | null
  syncState: 'local' | 'synced' | 'dirty' | 'conflict' | null
  updatedBy: string | null
}

export interface ChangeSetRecord {
  id: string
  fileId: string
  source: 'ai' | 'manual' | 'external'
  sourceCommand: string | null
  status: 'pending' | 'applied' | 'discarded' | 'partial' | 'stale'
  changes: unknown | null
  changesPath: string | null
  remoteId: string | null
  etag: string | null
  syncState: 'local' | 'synced' | 'dirty' | 'conflict' | null
  updatedBy: string | null
}

export interface ConversationRecord {
  id: string
  workspaceId: string
  title: string | null
  createdAt: number
  updatedAt: number
}

export interface MessageRecord {
  id: string
  conversationId: string
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  toolCalls: unknown | null
  changeSetId: string | null
  resultCards: unknown | null
  createdAt: number
}

export interface SearchHit {
  fileId: string
  snippet: string
  rank: number
}

export type DbRequestMap = {
  'db.ready': { request: undefined; response: { ok: true } }
  'workspace.ensure': {
    request: { id: string; name: string }
    response: { id: string }
  }
  'file.create': { request: FileRecord; response: FileRecord }
  'file.get': { request: { id: string }; response: FileRecord | null }
  'file.listByWorkspace': {
    request: { workspaceId: string; type?: 'word' | 'excel' | 'ppt' }
    response: FileRecord[]
  }
  'file.update': {
    request: { id: string; patch: Partial<FileRecord> }
    response: FileRecord | null
  }
  'file.delete': { request: { id: string }; response: { deleted: number } }
  'version.create': { request: VersionRecord; response: VersionRecord }
  'version.listByFile': {
    request: { fileId: string }
    response: VersionRecord[]
  }
  // T-S2-06 线性回溯：按 id 取单个版本（快照路径、seq、parent 链）。
  'version.get': { request: { id: string }; response: VersionRecord | null }
  'changeSet.create': { request: ChangeSetRecord; response: ChangeSetRecord }
  'changeSet.get': {
    request: { id: string }
    response: ChangeSetRecord | null
  }
  'changeSet.listPending': {
    request: undefined
    response: ChangeSetRecord[]
  }
  'changeSet.updateStatus': {
    request: { id: string; status: ChangeSetRecord['status'] }
    response: ChangeSetRecord | null
  }
  // T-S2-05 信任交互：resolve 后读取——changes 字段无论内联还是外置（>512KB），
  // 都返回解析后的完整值，供主进程做 accept 编辑映射、渲染层做 diff 展示。
  'changeSet.getResolved': {
    request: { id: string }
    response: ChangeSetRecord | null
  }
  'changeSet.listPendingResolved': {
    request: undefined
    response: ChangeSetRecord[]
  }
  // T-S2-05 拒绝分支：必须走 DataService.discardChangeSet（先删外置 changes 文件、
  // 再删 DB 行，架构 §5 清理顺序），而非裸 updateStatus——后者会留下孤儿外置文件。
  'changeSet.discard': {
    request: { id: string }
    response: ChangeSetRecord | null
  }
  'conversation.create': {
    request: ConversationRecord
    response: ConversationRecord
  }
  'message.create': { request: MessageRecord; response: MessageRecord }
  'message.listByConversation': {
    request: { conversationId: string }
    response: MessageRecord[]
  }
  'search.indexFile': {
    request: { fileId: string; content: string; metadata?: string }
    response: { ok: true }
  }
  'search.removeFile': {
    request: { fileId: string }
    response: { ok: true }
  }
  'search.query': {
    request: { query: string; limit?: number }
    response: SearchHit[]
  }
  'recovery.run': {
    request: undefined
    response: {
      pending: ChangeSetRecord[]
      cleanedTmp: number
      cleanedExternal: number
      // T-S2-06：孤儿版本快照（snapshots 目录中无 versions 行引用的
      // .snapshot.docx 及其残留 .tmp）清理数。
      cleanedSnapshots: number
    }
  }
}

export type DbRequestType = keyof DbRequestMap

export interface DbRequest<T extends DbRequestType = DbRequestType> {
  id: string
  type: T
  payload: DbRequestMap[T]['request']
}

export type DbResponse<T extends DbRequestType = DbRequestType> =
  | {
      id: string
      ok: true
      payload: DbRequestMap[T]['response']
    }
  | {
      id: string
      ok: false
      error: { message: string; code?: string }
    }
