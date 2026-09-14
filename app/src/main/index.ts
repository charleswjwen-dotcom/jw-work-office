import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { createLogger } from './logger'
import { DbClient } from './db/client'
import { FileClient } from './files/client'
import { importWordFile } from './import/import-service'

const log = createLogger('main')

// 默认工作区：T-S2 阶段尚无多工作区管理 UI，先用固定 id 承接导入。
// 后续 workspace 管理任务接入后，此常量由实际选中的工作区替代。
const DEFAULT_WORKSPACE_ID = 'ws-default'

let dbClient: DbClient | null = null
let fileClient: FileClient | null = null
let filesDir = ''

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
