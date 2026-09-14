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
