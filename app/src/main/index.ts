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
import { VersionService } from './trust/version-service'
import { ExternalWatchService } from './trust/external-watch'
import { KeyStoreService } from './security/key-store'
import { SafeStorageCrypto } from './security/safe-storage-crypto'
import { ModelConfigService } from './llm/model-config-service'
import type { ProviderStorePort } from './llm/provider-factory'
import type { ProviderStatusView, SaveModelConfigInput } from '../shared/ipc'

const log = createLogger('main')

// 默认工作区：T-S2 阶段尚无多工作区管理 UI，先用固定 id 承接导入。
// 后续 workspace 管理任务接入后，此常量由实际选中的工作区替代。
const DEFAULT_WORKSPACE_ID = 'ws-default'

let dbClient: DbClient | null = null
let fileClient: FileClient | null = null
let filesDir = ''
let agentService: AgentService | null = null
let trustService: TrustService | null = null
let versionService: VersionService | null = null
let externalWatch: ExternalWatchService | null = null
// T-S2-07：gateway 由局部变量提升为模块级——配置保存/设默认/删除后
// refreshProvider 热替换 Provider，新配置下一轮对话即生效，无需重启。
let gateway: LlmGateway | null = null
let keyStore: KeyStoreService | null = null
let modelConfigService: ModelConfigService | null = null
// 初始值 = 启动解析前的诚实降级态（initDataLayer 完成后被真实状态覆盖）。
let providerStatus: ProviderStatusView = { mode: 'mock', note: null, encryptionAvailable: false }

function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

// Provider 解析链的 DB+密钥端口（provider-factory 的注入点）：
// 启动装配与 refreshProvider 共用同一端口，保证两条路径优先级链一致（§3.6）。
function makeProviderStore(): ProviderStorePort {
  return {
    getDefaultConfig: async () =>
      (await dbClient?.request('modelConfig.getDefault', undefined)) ?? null,
    decryptKey: (ref) => keyStore?.getKey(ref) ?? null
  }
}

// 配置变更后热替换 Provider：重跑解析链（env → DB 默认配置 → Mock 诚实降级），
// 成功则 swap 并刷新状态徽章；失败保留旧 Provider 只告警（不中断对话）。
async function refreshProvider(): Promise<void> {
  if (!gateway || !keyStore) return
  try {
    const resolved = await resolveChatProvider(makeProviderStore())
    gateway.swapProvider(resolved.provider)
    providerStatus = {
      mode: resolved.mode,
      note: resolved.note ?? null,
      encryptionAvailable: keyStore.available()
    }
  } catch (err) {
    log.warn(
      { event: 'provider-refresh-failed', err: err instanceof Error ? err.message : String(err) },
      'provider refresh failed, keeping previous provider'
    )
  }
}

async function initDataLayer(): Promise<void> {
  const userData = app.getPath('userData')
  const dbFile = join(ensureDir(join(userData, 'db')), 'my-work-office.db')
  const dirs = {
    tmpDir: ensureDir(join(userData, 'tmp')),
    changesetDir: ensureDir(join(userData, 'changesets')),
    // T-S2-06 版本快照目录：后像快照 + 回溯快照都落此处，recovery 据此清孤儿。
    snapshotsDir: ensureDir(join(userData, 'snapshots'))
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
      cleanedExternal: recovery.cleanedExternal,
      cleanedSnapshots: recovery.cleanedSnapshots
    },
    'data layer ready, crash recovery done'
  )

  // === T-S2-07 密钥存储与模型配置服务（PRD 7A.2 / 架构 §3.6）===
  // safeStorage 加解密严格限定主进程；密文（base64）原子落
  // {userData}/secure/api-keys.json，DB 的 model_configs 只存 key-<uuid> 引用。
  const secureDir = ensureDir(join(userData, 'secure'))
  keyStore = new KeyStoreService({ secureDir, crypto: new SafeStorageCrypto() })
  modelConfigService = new ModelConfigService({ dbPort: dbClient, keyStore })

  // === Agent 栈装配（T-S2-04，架构 §3.1/§3.5）===
  // Provider（真实 OpenAI 兼容或 Mock 诚实降级，见 provider-factory）→ Gateway
  // （重试/超时/用量计量，共享 UsageMeter 账本）→ Tool Registry（replaceText
  // 绑定 DocumentSession 的段落解析）→ AgentService（每轮编排）。
  // 必须在数据层就绪后装配：DocumentSession 依赖 db/file 两个客户端。
  // T-S2-07：resolveChatProvider 为 async——env 缺失时走 DB 默认配置 +
  // KeyStore 主进程解密（§3.6），共享 UsageMeter 账本跨热替换保留（§3.5）。
  const resolved = await resolveChatProvider(makeProviderStore())
  const usageMeter = new UsageMeter(resolved.provider.id)
  gateway = new LlmGateway(resolved.provider, { usage: usageMeter })
  const session = new DocumentSession({ dbClient, fileClient })
  const registry = new ToolRegistry()
  registry.register(createReplaceTextTool(session.resolveParagraph))
  // T-S2-05：TrustService 结构化端口直接注入真实 client（request 签名一致），
  // AgentService 借它把每轮 pending ChangeSet 落库（架构 §5 信任流第 2 步）。
  // T-S2-06：VersionService 先装配，再作为 version 端口注入 TrustService——
  // accept 写入成功后自动生成后像快照（§5 7A.3）。
  versionService = new VersionService({
    dbPort: dbClient,
    filePort: fileClient,
    snapshotsDir: dirs.snapshotsDir
  })
  trustService = new TrustService({ dbPort: dbClient, filePort: fileClient, version: versionService })
  agentService = new AgentService({ gateway, registry, session, trust: trustService })
  providerStatus = {
    mode: resolved.mode,
    note: resolved.note ?? null,
    encryptionAvailable: keyStore.available()
  }
  log.info(
    { event: 'agent-ready', providerMode: resolved.mode, note: resolved.note },
    'agent stack ready'
  )

  // === T-S2-05A 外部编辑感知（PRD 2A.6 第 2 层）===
  // 启动即全量扫描一次（重建内存检出态——含上次运行期间未处理的外部改动），
  // 随后 fs.watch 去抖监听。扫描失败不阻断启动（渲染层有手动扫描按钮兜底）。
  externalWatch = new ExternalWatchService({
    dbPort: dbClient,
    filePort: fileClient,
    versionPort: versionService,
    filesDir
  })
  void externalWatch.scan().catch((err) => {
    log.warn(
      { event: 'external-startup-scan', err: err instanceof Error ? err.message : String(err) },
      'startup external scan failed'
    )
  })
  externalWatch.startWatching()
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

  // === T-S2-06 版本历史与线性回溯（架构 §5 / PRD 3.3）===
  // 版本流程错误（VersionFlowError(code)）与信任流同构，复用 toTrustError 包装。
  ipcMain.handle('version:list', async (_e, fileId: string) => {
    if (!versionService) return []
    return versionService.listVersionViews(fileId)
  })

  ipcMain.handle('version:diff', async (_e, versionId: string) => {
    if (!versionService) {
      throw new Error('VERSION_NOT_READY')
    }
    try {
      return { ok: true, ...(await versionService.getVersionDiff(versionId)) }
    } catch (err) {
      return { ok: false, error: toTrustError(err) }
    }
  })

  ipcMain.handle('version:restore', async (_e, versionId: string) => {
    if (!versionService) {
      throw new Error('VERSION_NOT_READY')
    }
    try {
      return { ok: true, ...(await versionService.restore(versionId)) }
    } catch (err) {
      return { ok: false, error: toTrustError(err) }
    }
  })

  // === T-S2-05A 手动微调与外部编辑感知（PRD 2A.6 / 架构 §5.1）===
  // 手动微调产出标准 ChangeSet(source=manual) 走信任流；外部编辑三选项：
  // 采纳=ChangeSet(source=external)+Version(author=external)+基线前移，忽略=仅基线前移。
  // 错误规范与信任流一致：TrustFlowError/ExternalWatchError(code) → { ok:false, error }。
  ipcMain.handle('file:getParagraphs', async (_e, fileId: string) => {
    if (!dbClient || !fileClient) {
      return { ok: false, error: { code: 'DATA_LAYER_NOT_READY', message: '数据层未就绪' } }
    }
    try {
      const file = await dbClient.request('file.get', { id: fileId })
      if (!file) {
        return { ok: false, error: { code: 'FILE_NOT_FOUND', message: `文件 ${fileId} 不存在` } }
      }
      const { paragraphs } = await fileClient.request('word.parseParagraphs', {
        sourcePath: file.path
      })
      return { ok: true, paragraphs }
    } catch (err) {
      return { ok: false, error: toTrustError(err) }
    }
  })

  ipcMain.handle(
    'manual:createChangeset',
    async (_e, fileId: string, editedParagraphs: { index: number; text: string }[]) => {
      if (!trustService) {
        return { ok: false, error: { code: 'TRUST_NOT_READY', message: '信任服务未就绪' } }
      }
      try {
        const { changeSet, changeCount } = await trustService.createManualPending(
          fileId,
          editedParagraphs
        )
        return { ok: true, changeSetId: changeSet?.id, changeCount }
      } catch (err) {
        return { ok: false, error: toTrustError(err) }
      }
    }
  )

  ipcMain.handle('external:listDetected', async () => {
    if (!externalWatch) return []
    return externalWatch.listDetected()
  })

  ipcMain.handle('external:getDiff', async (_e, fileId: string) => {
    if (!externalWatch) {
      return { ok: false, error: { code: 'WATCH_NOT_READY', message: '外部编辑感知未就绪' } }
    }
    try {
      return { ok: true, changes: await externalWatch.getExternalDiff(fileId) }
    } catch (err) {
      return { ok: false, error: toTrustError(err) }
    }
  })

  ipcMain.handle('external:accept', async (_e, fileId: string) => {
    if (!externalWatch) {
      return { ok: false, error: { code: 'WATCH_NOT_READY', message: '外部编辑感知未就绪' } }
    }
    try {
      return { ok: true, ...(await externalWatch.acceptExternal(fileId)) }
    } catch (err) {
      return { ok: false, error: toTrustError(err) }
    }
  })

  ipcMain.handle('external:ignore', async (_e, fileId: string) => {
    if (!externalWatch) {
      return { ok: false, error: { code: 'WATCH_NOT_READY', message: '外部编辑感知未就绪' } }
    }
    try {
      return { ok: true, contentHash: await externalWatch.ignoreExternal(fileId) }
    } catch (err) {
      return { ok: false, error: toTrustError(err) }
    }
  })

  ipcMain.handle('external:scan', async () => {
    if (!externalWatch) return []
    return externalWatch.scan()
  })

  // === T-S2-07 模型配置通道（PRD 7A.2 / 架构 §3.6）===
  // 密钥明文只在主进程存续：list/setDefault 返回掩码视图；save/delete 后
  // refreshProvider 热替换 Provider 使新配置下一轮对话即生效。
  // 错误规范与信任流一致：Error('CODE: message') → toTrustError 降级。
  ipcMain.handle('model:list', async () => {
    if (!modelConfigService) return []
    return modelConfigService.listViews()
  })

  ipcMain.handle('model:save', async (_e, input: SaveModelConfigInput) => {
    if (!modelConfigService) {
      return {
        ok: false,
        error: { code: 'MODEL_CONFIG_NOT_READY', message: '模型配置服务未就绪' }
      }
    }
    try {
      const config = await modelConfigService.save(input)
      await refreshProvider()
      return { ok: true, config }
    } catch (err) {
      return { ok: false, error: toTrustError(err) }
    }
  })

  ipcMain.handle('model:delete', async (_e, id: string) => {
    if (!modelConfigService) {
      return {
        ok: false,
        error: { code: 'MODEL_CONFIG_NOT_READY', message: '模型配置服务未就绪' }
      }
    }
    try {
      await modelConfigService.remove(id)
      await refreshProvider()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: toTrustError(err) }
    }
  })

  ipcMain.handle('model:setDefault', async (_e, id: string) => {
    if (!modelConfigService) {
      return {
        ok: false,
        error: { code: 'MODEL_CONFIG_NOT_READY', message: '模型配置服务未就绪' }
      }
    }
    try {
      const config = await modelConfigService.setDefault(id)
      await refreshProvider()
      return { ok: true, config }
    } catch (err) {
      return { ok: false, error: toTrustError(err) }
    }
  })

  ipcMain.handle('model:status', () => providerStatus)

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
  // T-S2-05A：先停 fs.watch（去抖定时器一并清理），再关数据层。
  externalWatch?.stopWatching()
  dbClient?.close().catch(() => undefined)
  dbClient = null
  fileClient?.close().catch(() => undefined)
  fileClient = null
})
