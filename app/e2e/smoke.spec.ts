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
