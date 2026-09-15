import type {
  ChangeSetRecord,
  DbRequest,
  DbRequestType,
  DbResponse,
  FileRecord,
  ModelConfigRecord
} from '../../shared/db-protocol'
import { openDatabase } from './connection'
import { DataService } from './data-service'

const service = new DataService({
  handle: openDatabase(process.env.MWO_DB_FILE ?? ':memory:'),
  dirs: {
    tmpDir: process.env.MWO_TMP_DIR ?? '.',
    changesetDir: process.env.MWO_CHANGESET_DIR ?? '.',
    ...(process.env.MWO_SNAPSHOT_DIR ? { snapshotsDir: process.env.MWO_SNAPSHOT_DIR } : {})
  }
})

function handle(req: DbRequest): unknown {
  switch (req.type) {
    case 'db.ready':
      return { ok: true as const }
    case 'workspace.ensure': {
      const p = req.payload as { id: string; name: string }
      return service.workspaces.ensure(p.id, p.name)
    }
    case 'file.create':
      return service.files.create(req.payload as FileRecord)
    case 'file.get':
      return service.files.get((req.payload as { id: string }).id)
    case 'file.listByWorkspace': {
      const p = req.payload as { workspaceId: string; type?: FileRecord['type'] }
      return service.files.listByWorkspace(p.workspaceId, p.type)
    }
    case 'file.update': {
      const p = req.payload as { id: string; patch: Partial<FileRecord> }
      return service.files.update(p.id, p.patch)
    }
    case 'file.delete':
      return { deleted: service.files.delete((req.payload as { id: string }).id) }
    // T-S2-05A 外部编辑感知：跨工作区全量清单（含基线字段）。
    case 'file.listAll':
      return service.files.listAll()
    case 'version.create':
      return service.versions.create(req.payload as never)
    case 'version.listByFile':
      return service.versions.listByFile((req.payload as { fileId: string }).fileId)
    case 'version.get':
      return service.versions.get((req.payload as { id: string }).id)
    case 'changeSet.create':
      return service.createChangeSet(req.payload as ChangeSetRecord)
    case 'changeSet.get':
      return service.changeSets.get((req.payload as { id: string }).id)
    case 'changeSet.listPending':
      return service.changeSets.listPending()
    case 'changeSet.updateStatus': {
      const p = req.payload as { id: string; status: ChangeSetRecord['status'] }
      return service.changeSets.updateStatus(p.id, p.status)
    }
    case 'changeSet.getResolved':
      return service.getResolvedChangeSet((req.payload as { id: string }).id)
    case 'changeSet.listPendingResolved':
      return service.listPendingResolved()
    case 'changeSet.discard':
      // 架构 §5 清理顺序：先删外置 changes 文件、再删 DB 行（DataService 内实现）。
      return service.discardChangeSet((req.payload as { id: string }).id)
    case 'changeSet.countByFileStatus': {
      // T-S2-05A 冲突消解：外部编辑检出时统计该文件 stale 变更集数量。
      const p = req.payload as { fileId: string; status: ChangeSetRecord['status'] }
      return { count: service.changeSets.countByFileStatus(p.fileId, p.status) }
    }
    case 'conversation.create':
      return service.conversations.create(req.payload as never)
    case 'message.create':
      return service.conversations.createMessage(req.payload as never)
    case 'message.listByConversation':
      return service.conversations.listMessages(
        (req.payload as { conversationId: string }).conversationId
      )
    case 'search.indexFile': {
      const p = req.payload as { fileId: string; content: string; metadata?: string }
      service.search.indexFile(p.fileId, p.content, p.metadata)
      return { ok: true as const }
    }
    case 'search.removeFile':
      service.search.removeFile((req.payload as { fileId: string }).fileId)
      return { ok: true as const }
    case 'search.query': {
      const p = req.payload as { query: string; limit?: number }
      return service.search.query(p.query, p.limit)
    }
    case 'recovery.run':
      return service.runRecovery()
    // —— T-S2-07 多模型配置 CRUD ——
    case 'modelConfig.create':
      return service.modelConfigs.create(req.payload as ModelConfigRecord)
    case 'modelConfig.get':
      return service.modelConfigs.get((req.payload as { id: string }).id)
    case 'modelConfig.list':
      return service.modelConfigs.list()
    case 'modelConfig.update': {
      const p = req.payload as { id: string; patch: Partial<ModelConfigRecord> }
      return service.modelConfigs.update(p.id, p.patch)
    }
    case 'modelConfig.delete':
      return { deleted: service.modelConfigs.delete((req.payload as { id: string }).id) }
    case 'modelConfig.getDefault':
      return service.modelConfigs.getDefault()
    case 'modelConfig.setDefault':
      return service.modelConfigs.setDefault((req.payload as { id: string }).id)
    default: {
      const exhaustive: never = req.type as never
      throw new Error(`Unknown db request type: ${String(exhaustive)}`)
    }
  }
}

process.parentPort?.on('message', (event) => {
  const req = event.data as DbRequest
  let response: DbResponse
  try {
    const payload = handle(req)
    response = { id: req.id, ok: true, payload: payload as never }
  } catch (err) {
    response = {
      id: req.id,
      ok: false,
      error: { message: err instanceof Error ? err.message : String(err) }
    }
  }
  process.parentPort?.postMessage(response)
})

export type { DbRequestType }
