import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs'

// 原子落盘（架构 §5 / 7A.3）：写 .tmp → fsync → rename。
// rename 在同一文件系统内是原子操作，因此崩溃时文件要么是旧版要么是新版，
// 绝不会出现"半写"状态；崩溃恢复只需清理残留 .tmp（见 recovery.ts）。
// 兼容 string 与 Buffer：DB 层写 JSON（string），文件引擎导入 .docx 写二进制（Buffer）。
export function atomicWriteFileSync(filePath: string, data: string | Buffer): void {
  const tmpPath = `${filePath}.tmp`
  const fd = openSync(tmpPath, 'w')
  try {
    writeSync(fd, data as never)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmpPath, filePath)
}

export function safeUnlink(filePath: string): boolean {
  try {
    unlinkSync(filePath)
    return true
  } catch {
    return false
  }
}
