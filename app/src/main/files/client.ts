import { randomUUID } from 'node:crypto'
import { utilityProcess, type UtilityProcess } from 'electron'
import type {
  FileRequest,
  FileRequestMap,
  FileRequestType,
  FileResponse
} from '../../shared/file-protocol'

// 文件引擎主进程客户端（架构 §2「主进程只做调度与结果收发」）。
//
// 与 DbClient 结构对称：utilityProcess.fork 启动独立 Node ABI 进程，
// 用 { id, type, payload } 请求关联响应。刻意与 DbClient 分开两个实例，
// 对应两个物理进程（解析 / 写库隔离，见 files/worker.ts 顶部说明）。

interface Pending {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
}

export interface FileClientOptions {
  workerPath: string
}

export class FileClient {
  private readonly child: UtilityProcess
  private readonly pending = new Map<string, Pending>()
  private ready: Promise<void>

  constructor(options: FileClientOptions) {
    this.child = utilityProcess.fork(options.workerPath, [], {
      serviceName: 'mwo-file-engine'
    })

    this.ready = new Promise<void>((resolve) => {
      this.child.once('spawn', () => resolve())
    })

    this.child.on('message', (res: FileResponse) => {
      const entry = this.pending.get(res.id)
      if (!entry) return
      this.pending.delete(res.id)
      if (res.ok) entry.resolve(res.payload)
      else entry.reject(new Error(res.error.message))
    })

    // 进程退出：拒绝所有挂起请求，避免调用方无限等待。
    // 后续可在此加自愈重启（当前策略：崩溃仅影响进行中的解析，主进程与 DB 不受影响）。
    this.child.on('exit', (code) => {
      const err = new Error(`file engine worker exited with code ${code}`)
      for (const entry of this.pending.values()) entry.reject(err)
      this.pending.clear()
    })
  }

  async request<T extends FileRequestType>(
    type: T,
    payload: FileRequestMap[T]['request']
  ): Promise<FileRequestMap[T]['response']> {
    await this.ready
    const id = randomUUID()
    const message: FileRequest<T> = { id, type, payload }
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject
      })
      this.child.postMessage(message)
    })
  }

  async close(): Promise<void> {
    this.child.kill()
  }
}
