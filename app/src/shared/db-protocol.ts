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

// —— T-S2-07 多模型配置（架构 §4 model_configs 表）——
// 行内只存 apiKeyRef 引用（指向 KeyStore 的 key-<uuid>），密文在
// {userData}/secure/api-keys.json——明文既不进 DB，也不出主进程（PRD 7A.2）。
export interface ModelConfigRecord {
  id: string
  name: string
  // M1 冻结：仅 'openai-compatible'（HLD §3.5，OpenAI 兼容端点含 Ollama/vLLM）。
  protocol: string
  baseUrl: string | null
  model: string
  apiKeyRef: string | null
  isDefault: boolean
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
  // T-S2-05A 外部编辑感知：跨工作区全量文件清单（含 contentHash/modifiedAt
  // 基线），供启动扫描与 fs.watch 去抖后的重扫做权威比对。
  'file.listAll': { request: undefined; response: FileRecord[] }
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
  // T-S2-05A 冲突消解：外部编辑检出时统计该文件被置 stale 的变更集数量
  // （含历史已处理记录——重启后仍可追溯），供 UI 显式提示「有 N 个待确认变更失效」。
  'changeSet.countByFileStatus': {
    request: { fileId: string; status: ChangeSetRecord['status'] }
    response: { count: number }
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
  // —— T-S2-07 多模型配置 CRUD（ModelConfigService 经 DbClient 调用）——
  // delete 依赖 usage_records.model_id 的 FK cascade 一并清理用量行。
  'modelConfig.create': { request: ModelConfigRecord; response: ModelConfigRecord }
  'modelConfig.get': { request: { id: string }; response: ModelConfigRecord | null }
  'modelConfig.list': { request: undefined; response: ModelConfigRecord[] }
  'modelConfig.update': {
    request: { id: string; patch: Partial<ModelConfigRecord> }
    response: ModelConfigRecord | null
  }
  'modelConfig.delete': { request: { id: string }; response: { deleted: number } }
  'modelConfig.getDefault': { request: undefined; response: ModelConfigRecord | null }
  // setDefault 在 DB 事务内先清全部默认再置目标，避免双默认中间态。
  'modelConfig.setDefault': { request: { id: string }; response: ModelConfigRecord | null }
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
