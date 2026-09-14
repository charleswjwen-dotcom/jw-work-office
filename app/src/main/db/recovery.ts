import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ChangeSetRecord } from '../../shared/db-protocol'
import { safeUnlink } from './atomic-write'
import type { ChangeSetRepository } from './repositories'

export const CHANGES_EXTERNAL_THRESHOLD = 512 * 1024

export interface RecoveryDirs {
  tmpDir: string
  changesetDir: string
}

export interface RecoveryResult {
  pending: ChangeSetRecord[]
  cleanedTmp: number
  cleanedExternal: number
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
  dirs: RecoveryDirs
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

  return { pending, cleanedTmp, cleanedExternal }
}
