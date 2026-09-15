import { randomUUID } from 'node:crypto'
import { utilityProcess, type UtilityProcess } from 'electron'
import type {
  DbRequest,
  DbRequestMap,
  DbRequestType,
  DbResponse
} from '../../shared/db-protocol'
import type { RecoveryDirs } from './recovery'

interface Pending {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
}

export interface DbClientOptions {
  workerPath: string
  dbFile: string
  dirs: RecoveryDirs
}

export class DbClient {
  private readonly child: UtilityProcess
  private readonly pending = new Map<string, Pending>()
  private ready: Promise<void>

  constructor(options: DbClientOptions) {
    this.child = utilityProcess.fork(options.workerPath, [], {
      serviceName: 'mwo-db',
      env: {
        ...process.env,
        MWO_DB_FILE: options.dbFile,
        MWO_TMP_DIR: options.dirs.tmpDir,
        MWO_CHANGESET_DIR: options.dirs.changesetDir,
        // T-S2-06：快照目录转发（可选——提供时 db-worker 的 recovery 才清孤儿快照）。
        ...(options.dirs.snapshotsDir
          ? { MWO_SNAPSHOT_DIR: options.dirs.snapshotsDir }
          : {})
      }
    })

    this.ready = new Promise<void>((resolve) => {
      this.child.once('spawn', () => resolve())
    })

    this.child.on('message', (res: DbResponse) => {
      const entry = this.pending.get(res.id)
      if (!entry) return
      this.pending.delete(res.id)
      if (res.ok) entry.resolve(res.payload)
      else entry.reject(new Error(res.error.message))
    })

    this.child.on('exit', (code) => {
      const err = new Error(`db worker exited with code ${code}`)
      for (const entry of this.pending.values()) entry.reject(err)
      this.pending.clear()
    })
  }

  async request<T extends DbRequestType>(
    type: T,
    payload: DbRequestMap[T]['request']
  ): Promise<DbRequestMap[T]['response']> {
    await this.ready
    const id = randomUUID()
    const message: DbRequest<T> = { id, type, payload }
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
