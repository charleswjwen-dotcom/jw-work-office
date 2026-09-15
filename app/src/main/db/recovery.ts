import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ChangeSetRecord } from '../../shared/db-protocol'
import { safeUnlink } from './atomic-write'
import type { ChangeSetRepository, VersionRepository } from './repositories'

export const CHANGES_EXTERNAL_THRESHOLD = 512 * 1024

export interface RecoveryDirs {
  tmpDir: string
  changesetDir: string
  // T-S2-06：快照目录。可选——旧构造（data-service.test.ts 等）不带 snapshotsDir，
  // 快照清理仅在显式提供时执行（向后兼容）。
  snapshotsDir?: string
}

export interface RecoveryResult {
  pending: ChangeSetRecord[]
  cleanedTmp: number
  cleanedExternal: number
  // T-S2-06：孤儿快照（snapshots 目录中无 versions 行引用的 .snapshot.docx
  // 及其残留 .tmp）清理数。
  cleanedSnapshots: number
}

function listFiles(dir: string, suffix: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith(suffix))
    .map((name) => join(dir, name))
}

function changeSetIdFromPath(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  return base.replace(/\.changeset$/, '')
}

export function runCrashRecovery(
  changeSetRepo: ChangeSetRepository,
  dirs: RecoveryDirs,
  versionRepo?: VersionRepository
): RecoveryResult {
  const pending = changeSetRepo.listPending()

  let cleanedTmp = 0
  for (const tmp of listFiles(dirs.tmpDir, '.tmp')) {
    try {
      if (statSync(tmp).isFile() && safeUnlink(tmp)) cleanedTmp += 1
    } catch {
      /* ignore */
    }
  }

  let cleanedExternal = 0
  const validIds = new Set<string>()
  for (const cs of pending) {
    if (cs.changesPath) validIds.add(changeSetIdFromPath(cs.changesPath))
  }
  for (const external of listFiles(dirs.changesetDir, '.changeset')) {
    const id = changeSetIdFromPath(external)
    const cs = changeSetRepo.get(id)
    const orphan = cs === null || cs.status === 'discarded'
    if (orphan) {
      if (safeUnlink(external)) cleanedExternal += 1
    }
  }

  // T-S2-06 快照孤儿清理：snapshots 目录中未被任何 versions 行引用的快照。
  // 后缀 '.snapshot.docx' 与 version-service 的 SNAPSHOT_SUFFIX 约定一致
  // （勿改一处漏一处——db 层不反向 import trust 层，故此处用字面量）。
  let cleanedSnapshots = 0
  if (dirs.snapshotsDir && versionRepo) {
    const referenced = new Set(versionRepo.listSnapshotPaths())
    for (const snapshot of listFiles(dirs.snapshotsDir, '.snapshot.docx')) {
      if (!referenced.has(snapshot)) {
        if (safeUnlink(snapshot)) cleanedSnapshots += 1
      }
    }
    // copyFileAtomicSync 的崩溃残留 .tmp（快照写一半）：以 .tmp 结尾、不以
    // .snapshot.docx 结尾，与上面的孤儿快照枚举天然不相交，不会双计。
    for (const tmp of listFiles(dirs.snapshotsDir, '.tmp')) {
      try {
        if (statSync(tmp).isFile() && safeUnlink(tmp)) cleanedSnapshots += 1
      } catch {
        /* ignore */
      }
    }
  }

  return { pending, cleanedTmp, cleanedExternal, cleanedSnapshots }
}
