import type { FileRequest, FileResponse } from '../../shared/file-protocol'
import { copyFileAtomicSync } from '../db/atomic-write'
import { convertWordToHtml, parseWordFile, splitParagraphs } from './word-parser'
import { applyParagraphEdits } from './word-writer'

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
    case 'word.applyParagraphEdits': {
      // T-S2-05 信任交互 accept 分支：确认后确定性改写（写入器内部完成
      // expectedBefore 对齐校验与 .tmp→fsync→rename 原子落盘，架构 §5）。
      const p = req.payload as {
        sourcePath: string
        edits: import('../../shared/file-protocol').WordParagraphEdit[]
      }
      return applyParagraphEdits(p.sourcePath, p.edits)
    }
    case 'word.parseParagraphs': {
      // T-S2-06 版本 diff 预览/回溯：按 splitParagraphs 唯一规则源切段
      // （非空段从 0 计数），段落口径与解析/写入侧严格一致（file-protocol 注释）。
      const p = req.payload as { sourcePath: string }
      const parsed = await parseWordFile(p.sourcePath)
      return { paragraphs: splitParagraphs(parsed.text) }
    }
    case 'word.convertToHtml': {
      // T-S2-08 右栏预览：mammoth HTML 转换（CPU 密集，与解析同进程隔离，
      // 不阻塞主进程 IPC 与 SQLite 响应，架构 §2/7A.1）。只做忠实转换；
      // 消毒在主进程完成（html-sanitizer.ts，架构 §2 安全红线）。
      const p = req.payload as { sourcePath: string }
      return { html: await convertWordToHtml(p.sourcePath) }
    }
    case 'file.copy': {
      // T-S2-06：字节级原子复制（.tmp→fsync→rename）。快照落盘与回溯替换共用。
      const p = req.payload as { sourcePath: string; destPath: string }
      return { byteSize: copyFileAtomicSync(p.sourcePath, p.destPath) }
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
