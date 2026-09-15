import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { createLogger } from './logger'
import { DbClient } from './db/client'
import { FileClient } from './files/client'
import { importWordFile } from './import/import-service'
import { resolveChatProvider } from './llm/provider-factory'
import { LlmGateway } from './llm/gateway'
import { UsageMeter } from './llm/usage-meter'
import { ToolRegistry } from './tools/registry'
import { createReplaceTextTool } from './tools/replace-text-tool'
import { DocumentSession } from './agent/document-session'
import { AgentService } from './agent/agent-service'
import { TrustService } from './trust/trust-service'

const log = createLogger('main')

// 默认工作区：T-S2 阶段尚无多工作区管理 UI，先用固定 id 承接导入。
// 后续 workspace 管理任务接入后，此常量由实际选中的工作区替代。
const DEFAULT_WORKSPACE_ID = 'ws-default'

let dbClient: DbClient | null = null
let fileClient: FileClient | null = null
let filesDir = ''
let agentService: AgentService | null = null
let trustService: TrustService | null = null

function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

async function initDataLayer(): Promise<void> {
  const userData = app.getPath('userData')
  const dbFile = join(ensureDir(join(userData, 'db')), 'my-work-office.db')
  const dirs = {
    tmpDir: ensureDir(join(userData, 'tmp')),
    changesetDir: ensureDir(join(userData, 'changesets'))
  }
  // 导入文件副本目录：源文件复制进此处，改写只针对副本，不动用户原始文件（§5）。
  filesDir = ensureDir(join(userData, 'files'))

  const workerPath = join(__dirname, 'db-worker.js')
  dbClient = new DbClient({ workerPath, dbFile, dirs })
  await dbClient.request('db.ready', undefined)

  // 确保默认工作区行存在（幂等）。files.workspace_id 有 FK 约束且 foreign_keys=ON，
  // 缺这行会让所有导入在写库阶段被外键拒绝。
  await dbClient.request('workspace.ensure', {
    id: DEFAULT_WORKSPACE_ID,
    name: '默认工作区'
  })

  // 文件引擎独立进程（与 DB 进程隔离，见 files/worker.ts 顶部说明）。
  fileClient = new FileClient({ workerPath: join(__dirname, 'file-worker.js') })
  await fileClient.request('file.ready', undefined)

  const recovery = await dbClient.request('recovery.run', undefined)
  log.info(
    {
      event: 'db-ready',
      pending: recovery.pending.length,
      cleanedTmp: recovery.cleanedTmp,
      cleanedExternal: recovery.cleanedExternal
    },
    'data layer ready, crash recovery done'
  )

  // === Agent 栈装配（T-S2-04，架构 §3.1/§3.5）===
  // Provider（真实 OpenAI 兼容或 Mock 诚实降级，见 provider-factory）→ Gateway
  // （重试/超时/用量计量，共享 UsageMeter 账本）→ Tool Registry（replaceText
  // 绑定 DocumentSession 的段落解析）→ AgentService（每轮编排）。
  // 必须在数据层就绪后装配：DocumentSession 依赖 db/file 两个客户端。
  const resolved = resolveChatProvider()
  const usageMeter = new UsageMeter(resolved.provider.id)
  const gateway = new LlmGateway(resolved.provider, { usage: usageMeter })
  const session = new DocumentSession({ dbClient, fileClient })
  const registry = new ToolRegistry()
  registry.register(createReplaceTextTool(session.resolveParagraph))
  // T-S2-05：TrustService 结构化端口直接注入真实 client（request 签名一致），
  // AgentService 借它把每轮 pending ChangeSet 落库（架构 §5 信任流第 2 步）。
  trustService = new TrustService({ dbPort: dbClient, filePort: fileClient })
  agentService = new AgentService({ gateway, registry, session, trust: trustService })
  log.info(
    { event: 'agent-ready', providerMode: resolved.mode, note: resolved.note },
    'agent stack ready'
  )
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
    log.info({ event: 'window-ready' }, 'main window ready to show')
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.my-work-office')
  log.info({ event: 'app-ready', platform: process.platform }, 'app ready')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  ipcMain.handle('ping', () => {
    log.debug({ event: 'ipc', channel: 'ping' }, 'ipc invoked')
    return 'pong'
  })

  // 文件选择 + 导入：dialog 必须在主进程调用（架构 §2，渲染层无 fs/dialog 权限）。
  ipcMain.handle('file:importWord', async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const picked = await dialog.showOpenDialog(win, {
      title: '导入 Word 文档',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Word', extensions: ['docx', 'doc'] }]
    })
    if (picked.canceled || picked.filePaths.length === 0) {
      return { canceled: true, imported: [], failures: [] }
    }
    if (!dbClient || !fileClient) {
      throw new Error('DATA_LAYER_NOT_READY')
    }
    const deps = {
      fileClient,
      dbClient,
      layout: { filesDir }
    }
    // 单文件失败不阻断整批：逐个 try，失败收进 failures 返回给 UI 展示原因（PRD F1-1）。
    const imported: Awaited<ReturnType<typeof importWordFile>>[] = []
    const failures: { path: string; reason: string }[] = []
    for (const p of picked.filePaths) {
      try {
        imported.push(await importWordFile(p, DEFAULT_WORKSPACE_ID, deps))
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        failures.push({ path: p, reason })
        log.warn({ event: 'import-failed', path: p, reason }, 'file import failed')
      }
    }
    log.info(
      { event: 'import-done', count: imported.length, failed: failures.length },
      'import finished'
    )
    return { canceled: false, imported, failures }
  })

  ipcMain.handle('file:list', async (_e, workspaceId?: string) => {
    if (!dbClient) return []
    return dbClient.request('file.listByWorkspace', {
      workspaceId: workspaceId ?? DEFAULT_WORKSPACE_ID
    })
  })

  ipcMain.handle('file:search', async (_e, query: string) => {
    if (!dbClient) return []
    return dbClient.request('search.query', { query })
  })

  // 对话一轮（T-S2-04）：结构化结果，业务错误走 ChatTurnResult.error 而非 throw，
  // 渲染层无需 try/catch（§3.1 IPC 错误规范化）。未知 fileId → ok:false + FILE_NOT_FOUND。
  ipcMain.handle('chat:send', async (_e, fileId: string, prompt: string) => {
    if (!agentService) {
      throw new Error('AGENT_NOT_READY')
    }
    return agentService.runTurn({ fileId, prompt })
  })

  // === T-S2-05 信任交互通道（架构 §5）===
  // 与 chat:send 同一错误规范：TrustFlowError(code) 统一降级为 { ok:false, error }，
  // 渲染层拿结构化结果（CHANGESET_NOT_FOUND / BASELINE_MISMATCH 等）直接可判型。
  const toTrustError = (err: unknown): { code: string; message: string } => {
    const message = err instanceof Error ? err.message : String(err)
    const code = /^([A-Z_]+):/.exec(message)?.[1] ?? 'TRUST_FLOW_FAILED'
    return { code, message }
  }

  ipcMain.handle('changeset:listPending', async () => {
    if (!trustService) return []
    return trustService.listPendingViews()
  })

  ipcMain.handle('changeset:accept', async (_e, id: string, acceptedChangeIds?: string[]) => {
    if (!trustService) {
      throw new Error('TRUST_NOT_READY')
    }
    try {
      return await trustService.accept(id, acceptedChangeIds)
    } catch (err) {
      return { ok: false, error: toTrustError(err) }
    }
  })

  ipcMain.handle('changeset:reject', async (_e, id: string) => {
    if (!trustService) {
      throw new Error('TRUST_NOT_READY')
    }
    try {
      return await trustService.reject(id)
    } catch (err) {
      return { ok: false, error: toTrustError(err) }
    }
  })

  createWindow()

  initDataLayer().catch((err) => {
    log.error(
      { event: 'db-init-failed', err: err instanceof Error ? err.message : String(err) },
      'data layer init failed'
    )
  })

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  log.info({ event: 'window-all-closed' }, 'all windows closed')
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('will-quit', () => {
  dbClient?.close().catch(() => undefined)
  dbClient = null
  fileClient?.close().catch(() => undefined)
  fileClient = null
})
