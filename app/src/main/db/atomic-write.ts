import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync
} from 'node:fs'

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

// T-S2-06 字节级原子复制（读源 → 原子写目标）：版本快照落盘（工作文件 →
// snapshots/）与回溯原子替换（快照 → 工作文件）共用同一原语，保证两条
// 路径的落盘语义一致（架构 §5.1 原子性）。返回字节数供版本元数据记录。
export function copyFileAtomicSync(sourcePath: string, destPath: string): number {
  const data = readFileSync(sourcePath)
  atomicWriteFileSync(destPath, data)
  return data.byteLength
}

export function safeUnlink(filePath: string): boolean {
  try {
    unlinkSync(filePath)
    return true
  } catch {
    return false
  }
}
