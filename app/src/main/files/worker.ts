import type { FileRequest, FileResponse } from '../../shared/file-protocol'
import { parseWordFile } from './word-parser'

// 文件引擎 Utility 进程入口（架构 §2「文件引擎必须运行在 Utility 进程」，7A.1）。
//
// 为什么单独一个进程，而不是塞进 db-worker：
// - 解析 .docx 是 CPU 密集 + 磁盘 IO，耗时随文件大小线性增长；
// - DB 进程承载 better-sqlite3 的同步写事务，若与解析共进程，一次大文件解析
//   会阻塞 SQLite 写响应，直接违反 §2「不阻塞主进程 IPC 与 SQLite 响应」的意图；
// - 两进程隔离后，解析崩溃不会击穿数据层（崩溃只影响本次导入，DB 与已导入数据无损）。
//
// 通信契约与 db-worker 完全一致（{id,type,payload} + parentPort），
// 复用同一套客户端骨架，降低协议漂移风险。

async function handle(req: FileRequest): Promise<unknown> {
  switch (req.type) {
    case 'file.ready':
      return { ok: true as const }
    case 'word.parse': {
      const p = req.payload as { sourcePath: string }
      return parseWordFile(p.sourcePath)
    }
    default: {
      const exhaustive: never = req.type as never
      throw new Error(`Unknown file request type: ${String(exhaustive)}`)
    }
  }
}

process.parentPort?.on('message', (event) => {
  const req = event.data as FileRequest
  void handle(req)
    .then((payload) => {
      const response: FileResponse = { id: req.id, ok: true, payload: payload as never }
      process.parentPort?.postMessage(response)
    })
    .catch((err) => {
      const response: FileResponse = {
        id: req.id,
        ok: false,
        error: { message: err instanceof Error ? err.message : String(err) }
      }
      process.parentPort?.postMessage(response)
    })
})
