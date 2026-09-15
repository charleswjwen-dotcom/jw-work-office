import { _electron as electron, test, expect, type ElectronApplication } from '@playwright/test'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MAIN_ENTRY = resolve(APP_ROOT, 'out/main/index.js')

let app: ElectronApplication

test.beforeAll(async () => {
  app = await electron.launch({
    args: [MAIN_ENTRY, '--no-sandbox'],
    cwd: APP_ROOT,
    env: { ...process.env, NODE_ENV: 'test' }
  })
})

test.afterAll(async () => {
  await app.close()
})

test('Electron 启动后主窗口可见', async () => {
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  expect(await window.title()).toBeTruthy()
  expect(app.windows().length).toBeGreaterThan(0)
})

test('渲染层挂载 React 根节点', async () => {
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  const root = window.locator('#root')
  await expect(root).toBeAttached()
})

test('IPC ping 通道可用（preload 白名单桥接）', async () => {
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  const pong = await window.evaluate(async () => {
    const api = (window as unknown as { api?: { ping?: () => Promise<string> } }).api
    if (!api?.ping) return 'NO_BRIDGE'
    return api.ping()
  })
  expect(pong).toBe('pong')
})

// 数据层冒烟：真实调用 listFiles 走通「主进程 → DB Utility 进程 → SQLite」全链路。
// 这条断言能捕获 initDataLayer 静默失败（如 db-worker/file-worker 无法 spawn、
// 迁移失败、workspace FK 缺失等）——纯窗口/ping 断言覆盖不到这些。
// initDataLayer 是异步的，用 expect.poll 等待其就绪。
test('数据层就绪：listFiles 返回数组（DB Utility 进程链路可用）', async () => {
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await expect
    .poll(
      async () =>
        window.evaluate(async () => {
          const api = (
            window as unknown as { api?: { listFiles?: () => Promise<unknown[]> } }
          ).api
          if (!api?.listFiles) return 'NO_BRIDGE'
          try {
            const files = await api.listFiles()
            return Array.isArray(files) ? 'ARRAY' : 'NOT_ARRAY'
          } catch {
            return 'NOT_READY'
          }
        }),
      { timeout: 15000, intervals: [250, 500, 1000] }
    )
    .toBe('ARRAY')
})

// T-S2-04 冒烟：chatSend 通道（preload 白名单 → 主进程 Agent 栈）。
// 用未知文件验证「结构化错误」契约：主流程异常不 throw 到渲染层，
// 而是降级为 ok:false + error.code（架构 §3.1 IPC 错误规范化）。
// Agent 栈在 whenReady 后异步装配：就绪前 handler 抛 AGENT_NOT_READY，
// evaluate 捕获后由 expect.poll 重试，直到栈就绪并返回 FILE_NOT_FOUND。
// 测试环境未配置 MWO_LLM_* 时 Provider 工厂落在 mock 模式，无需真实端点。
test('chatSend 通道可用：未知文件返回结构化 FILE_NOT_FOUND', async () => {
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await expect
    .poll(
      async () =>
        window.evaluate(async () => {
          const api = (
            window as unknown as {
              api?: { chatSend?: (fileId: string, prompt: string) => Promise<unknown> }
            }
          ).api
          if (!api?.chatSend) return 'NO_BRIDGE'
          try {
            const result = (await api.chatSend('no-such-file', '把"a"替换成"b"')) as {
              ok?: boolean
              error?: { code?: string }
            }
            if (result.ok) return 'OK_UNEXPECTED'
            return result.error?.code ?? 'NO_ERROR_CODE'
          } catch {
            return 'NOT_READY'
          }
        }),
      { timeout: 15000, intervals: [250, 500, 1000] }
    )
    .toBe('FILE_NOT_FOUND')
})

// T-S2-05 冒烟：信任交互三通道（架构 §5 信任交互数据流的 preload → 主进程链路）。
// listPending 无 pending 时安全默认空数组；accept/reject 对未知 id 返回
// 结构化 CHANGESET_NOT_FOUND（TrustFlowError 经 toTrustError 降级为
// { ok:false, error }，§3.1 IPC 错误规范化）而非 throw 到渲染层。
// 信任栈随 initDataLayer 异步装配：就绪前 handler 抛 TRUST_NOT_READY，
// evaluate 捕获后由 expect.poll 重试，直到返回结构化错误码。
test('changeset:listPending 通道可用：返回数组', async () => {
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await expect
    .poll(
      async () =>
        window.evaluate(async () => {
          const api = (
            window as unknown as { api?: { listPendingChangesets?: () => Promise<unknown[]> } }
          ).api
          if (!api?.listPendingChangesets) return 'NO_BRIDGE'
          try {
            const views = await api.listPendingChangesets()
            return Array.isArray(views) ? 'ARRAY' : 'NOT_ARRAY'
          } catch {
            return 'NOT_READY'
          }
        }),
      { timeout: 15000, intervals: [250, 500, 1000] }
    )
    .toBe('ARRAY')
})

test('changeset:accept 通道可用：未知 id 返回结构化 CHANGESET_NOT_FOUND', async () => {
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await expect
    .poll(
      async () =>
        window.evaluate(async () => {
          const api = (
            window as unknown as {
              api?: { acceptChangeset?: (id: string) => Promise<unknown> }
            }
          ).api
          if (!api?.acceptChangeset) return 'NO_BRIDGE'
          try {
            const result = (await api.acceptChangeset('no-such-changeset')) as {
              ok?: boolean
              error?: { code?: string }
            }
            if (result.ok) return 'OK_UNEXPECTED'
            return result.error?.code ?? 'NO_ERROR_CODE'
          } catch {
            return 'NOT_READY'
          }
        }),
      { timeout: 15000, intervals: [250, 500, 1000] }
    )
    .toBe('CHANGESET_NOT_FOUND')
})

test('changeset:reject 通道可用：未知 id 返回结构化 CHANGESET_NOT_FOUND', async () => {
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await expect
    .poll(
      async () =>
        window.evaluate(async () => {
          const api = (
            window as unknown as {
              api?: { rejectChangeset?: (id: string) => Promise<unknown> }
            }
          ).api
          if (!api?.rejectChangeset) return 'NO_BRIDGE'
          try {
            const result = (await api.rejectChangeset('no-such-changeset')) as {
              ok?: boolean
              error?: { code?: string }
            }
            if (result.ok) return 'OK_UNEXPECTED'
            return result.error?.code ?? 'NO_ERROR_CODE'
          } catch {
            return 'NOT_READY'
          }
        }),
      { timeout: 15000, intervals: [250, 500, 1000] }
    )
    .toBe('CHANGESET_NOT_FOUND')
})

// T-S2-06 冒烟：版本历史与线性回溯（架构 §5 快照数据流 / PRD 3.3）。
// listVersions 与 listPending 同为「读视图」通道：未知文件安全默认空数组；
// restoreVersion 对未知 id 返回结构化 VERSION_NOT_FOUND（VersionFlowError
// 复用 toTrustError 降级为 { ok:false, error }，§3.1 IPC 错误规范化）而非
// throw 到渲染层。版本栈随 initDataLayer 异步装配：就绪前 handler 抛
// VERSION_NOT_READY，evaluate 捕获后由 expect.poll 重试。
test('version:list 通道可用：未知文件返回空数组', async () => {
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await expect
    .poll(
      async () =>
        window.evaluate(async () => {
          const api = (
            window as unknown as {
              api?: { listVersions?: (fileId: string) => Promise<unknown[]> }
            }
          ).api
          if (!api?.listVersions) return 'NO_BRIDGE'
          try {
            const views = await api.listVersions('no-such-file')
            return Array.isArray(views) && views.length === 0 ? 'EMPTY_ARRAY' : 'NOT_EMPTY'
          } catch {
            return 'NOT_READY'
          }
        }),
      { timeout: 15000, intervals: [250, 500, 1000] }
    )
    .toBe('EMPTY_ARRAY')
})

test('version:restore 通道可用：未知 id 返回结构化 VERSION_NOT_FOUND', async () => {
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await expect
    .poll(
      async () =>
        window.evaluate(async () => {
          const api = (
            window as unknown as {
              api?: { restoreVersion?: (versionId: string) => Promise<unknown> }
            }
          ).api
          if (!api?.restoreVersion) return 'NO_BRIDGE'
          try {
            const result = (await api.restoreVersion('no-such-version')) as {
              ok?: boolean
              error?: { code?: string }
            }
            if (result.ok) return 'OK_UNEXPECTED'
            return result.error?.code ?? 'NO_ERROR_CODE'
          } catch {
            return 'NOT_READY'
          }
        }),
      { timeout: 15000, intervals: [250, 500, 1000] }
    )
    .toBe('VERSION_NOT_FOUND')
})

// T-S2-05A 冒烟：手动微调与外部编辑感知通道（架构 §5.1 / PRD 2A.6）。
// 与 chatSend/changeset 同一结构化错误契约：未知文件 → { ok:false, error.code }。
// getParagraphs 依赖数据层（DATA_LAYER_NOT_READY）、createManualChangeset 依赖
// 信任栈（TRUST_NOT_READY）、acceptExternalChange 依赖外部感知服务
// （WATCH_NOT_READY）——三者均为结构化返回而非 throw，evaluate 的 catch
// 不触发，expect.poll 持续重试直到各栈就绪并返回最终错误码。
test('file:getParagraphs 通道可用：未知文件返回结构化 FILE_NOT_FOUND', async () => {
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await expect
    .poll(
      async () =>
        window.evaluate(async () => {
          const api = (
            window as unknown as {
              api?: { getParagraphs?: (fileId: string) => Promise<unknown> }
            }
          ).api
          if (!api?.getParagraphs) return 'NO_BRIDGE'
          try {
            const result = (await api.getParagraphs('no-such-file')) as {
              ok?: boolean
              error?: { code?: string }
            }
            if (result.ok) return 'OK_UNEXPECTED'
            return result.error?.code ?? 'NO_ERROR_CODE'
          } catch {
            return 'NOT_READY'
          }
        }),
      { timeout: 15000, intervals: [250, 500, 1000] }
    )
    .toBe('FILE_NOT_FOUND')
})

test('manual:createChangeset 通道可用：未知文件返回结构化 FILE_NOT_FOUND', async () => {
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await expect
    .poll(
      async () =>
        window.evaluate(async () => {
          const api = (
            window as unknown as {
              api?: {
                createManualChangeset?: (
                  fileId: string,
                  editedParagraphs: { index: number; text: string }[]
                ) => Promise<unknown>
              }
            }
          ).api
          if (!api?.createManualChangeset) return 'NO_BRIDGE'
          try {
            const result = (await api.createManualChangeset('no-such-file', [])) as {
              ok?: boolean
              error?: { code?: string }
            }
            if (result.ok) return 'OK_UNEXPECTED'
            return result.error?.code ?? 'NO_ERROR_CODE'
          } catch {
            return 'NOT_READY'
          }
        }),
      { timeout: 15000, intervals: [250, 500, 1000] }
    )
    .toBe('FILE_NOT_FOUND')
})

test('external:accept 通道可用：未知文件返回结构化 FILE_NOT_FOUND', async () => {
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await expect
    .poll(
      async () =>
        window.evaluate(async () => {
          const api = (
            window as unknown as { api?: { acceptExternalChange?: (fileId: string) => Promise<unknown> } }
          ).api
          if (!api?.acceptExternalChange) return 'NO_BRIDGE'
          try {
            const result = (await api.acceptExternalChange('no-such-file')) as {
              ok?: boolean
              error?: { code?: string }
            }
            if (result.ok) return 'OK_UNEXPECTED'
            return result.error?.code ?? 'NO_ERROR_CODE'
          } catch {
            return 'NOT_READY'
          }
        }),
      { timeout: 15000, intervals: [250, 500, 1000] }
    )
    .toBe('FILE_NOT_FOUND')
})

// T-S2-07 冒烟：模型配置三通道（架构 §3.6 密钥管理 / PRD 7A.2 隐私红线）。
// list 与 status 是「读视图」通道：渲染层只拿窄字段视图（hasKey/maskedKey），
// 明文密钥永不出主进程。status 结构断言而非值断言：mode 受宿主 env（CI 可配
// MWO_LLM_*）与本地配置影响，两值皆合法。save 用空名称走校验失败路径——
// 验证 MODEL_CONFIG_INVALID 结构化错误契约且不写入任何数据。
test('model:list 通道可用：返回数组（窄字段视图）', async () => {
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await expect
    .poll(
      async () =>
        window.evaluate(async () => {
          const api = (
            window as unknown as { api?: { listModelConfigs?: () => Promise<unknown[]> } }
          ).api
          if (!api?.listModelConfigs) return 'NO_BRIDGE'
          try {
            const views = await api.listModelConfigs()
            return Array.isArray(views) ? 'ARRAY' : 'NOT_ARRAY'
          } catch {
            return 'NOT_READY'
          }
        }),
      { timeout: 15000, intervals: [250, 500, 1000] }
    )
    .toBe('ARRAY')
})

test('model:status 通道可用：返回结构完整的 ProviderStatusView', async () => {
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await expect
    .poll(
      async () =>
        window.evaluate(async () => {
          const api = (
            window as unknown as { api?: { getProviderStatus?: () => Promise<unknown> } }
          ).api
          if (!api?.getProviderStatus) return 'NO_BRIDGE'
          try {
            const status = (await api.getProviderStatus()) as {
              mode?: unknown
              note?: unknown
              encryptionAvailable?: unknown
            }
            if (status.mode !== 'openai-compatible' && status.mode !== 'mock') {
              return 'BAD_MODE'
            }
            if (typeof status.encryptionAvailable !== 'boolean') return 'BAD_ENCRYPTION_FLAG'
            if (!(status.note === null || typeof status.note === 'string')) return 'BAD_NOTE'
            return 'OK'
          } catch {
            return 'NOT_READY'
          }
        }),
      { timeout: 15000, intervals: [250, 500, 1000] }
    )
    .toBe('OK')
})

test('model:save 通道可用：空名称返回结构化 MODEL_CONFIG_INVALID', async () => {
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await expect
    .poll(
      async () =>
        window.evaluate(async () => {
          const api = (
            window as unknown as {
              api?: {
                saveModelConfig?: (input: {
                  name: string
                  protocol: string
                  model: string
                }) => Promise<unknown>
              }
            }
          ).api
          if (!api?.saveModelConfig) return 'NO_BRIDGE'
          try {
            const result = (await api.saveModelConfig({
              name: '   ',
              protocol: 'openai-compatible',
              model: 'any'
            })) as {
              ok?: boolean
              error?: { code?: string }
            }
            if (result.ok) return 'OK_UNEXPECTED'
            return result.error?.code ?? 'NO_ERROR_CODE'
          } catch {
            return 'NOT_READY'
          }
        }),
      { timeout: 15000, intervals: [250, 500, 1000] }
    )
    .toBe('MODEL_CONFIG_INVALID')
})
