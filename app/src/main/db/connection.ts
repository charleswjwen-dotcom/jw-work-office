import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { schema } from './schema'

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))

// ── better-sqlite3 原生模块的“双 ABI 共存”解析 ─────────────────────────────
// 背景（架构意图，勿轻易删改）：
//   better-sqlite3 是 C++ 原生模块，其编译产物按 NODE_MODULE_VERSION(ABI) 绑定运行时。
//   本项目存在两种运行时，各自 ABI 不同：
//     · 生产运行时 = Electron 33（内置 Node 20，NODE_MODULE_VERSION=130）
//     · 单元测试运行时 = 宿主 Node（vitest，NODE_MODULE_VERSION 随本机 Node 版本，如 127/147）
//   同一份 build/Release/*.node 只能匹配其中一个 ABI，另一个会在 new Database() 处崩溃
//   （历史上表现为 SIGSEGV 或 NODE_MODULE_VERSION 报错，详见 T-S2-02 修复记录）。
// 策略：
//   · build/Release/better_sqlite3.node 由 postinstall 的 electron-rebuild 固定为 Electron ABI，
//     供 Electron 运行时（含 DB Utility 进程）默认加载 —— 无需在此处显式指定。
//   · Node/vitest 环境（process.versions.electron 缺失）改用仓库内预编译的 Node-ABI 副本
//     vendor/better-sqlite3/better_sqlite3.node-abi.node，通过 Database 的 nativeBinding 选项注入。
//   如需升级 Electron 或 better-sqlite3，请同步刷新这两份产物（见 package.json 的 rebuild:electron 脚本）。
function resolveNativeBinding(): string | undefined {
  // 仅在“非 Electron 的纯 Node 运行时”下改用 Node-ABI 副本；Electron 内一律走默认解析。
  if (process.versions.electron) return undefined
  const nodeAbiBinding = resolve(MODULE_DIR, '../../../vendor/better-sqlite3/better_sqlite3.node-abi.node')
  return existsSync(nodeAbiBinding) ? nodeAbiBinding : undefined
}

export type Db = BetterSQLite3Database<typeof schema>

export interface DbHandle {
  db: Db
  raw: Database.Database
  close: () => void
}

function resolveMigrationsDir(): string {
  const candidates = [
    resolve(MODULE_DIR, 'migrations'),
    resolve(MODULE_DIR, '../db/migrations'),
    resolve(process.cwd(), 'src/main/db/migrations')
  ]
  for (const dir of candidates) {
    if (existsSync(join(dir, 'meta', '_journal.json'))) return dir
  }
  // 架构意图（勿删，fail-fast）：迁移目录缺失时若静默继续，会得到"零表空库"，
  // db.ready 照常返回，数据层却在首个建表/写入语句处崩——表现为所有 IPC 返回
  // DATA_LAYER_NOT_READY 且没有任何根因线索（2026-09 验收期伪安装包实测踩中，
  // 当时的形态：cwd=/ 时三候选全空）。这里必须抛出明确错误，让 initDataLayer
  // 在启动即失败并可见，而不是留一个窗口正常、数据全死的僵尸应用。
  throw new Error(
    `MIGRATIONS_DIR_NOT_FOUND: 未找到迁移目录（需含 meta/_journal.json），已尝试: ${candidates.join('; ')}`
  )
}

interface JournalEntry {
  idx: number
  tag: string
}

// 迁移记账表：记录已成功应用的迁移 tag，保证迁移“恰好执行一次”。
// 架构意图（勿删）：迁移 SQL 由 drizzle-kit 生成，是裸 CREATE TABLE（无 IF NOT EXISTS）。
//   若每次启动都全量重放，第二次启动就会因“表已存在”抛错，导致 initDataLayer 静默失败、
//   数据层永远 NOT_READY（历史缺陷：e2e 首次跑通、二次超时，即此因）。
//   因此这里维护 __mwo_migrations 记账表，仅应用尚未记录的迁移；每个迁移在单事务内
//   执行其全部语句 + 写入记账行，保证原子性（部分失败则整体回滚，可安全重试）。
const MIGRATIONS_TABLE = '__mwo_migrations'

function ensureMigrationsTable(raw: Database.Database): void {
  raw.exec(
    `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (` +
      'tag TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)'
  )
}

function appliedTags(raw: Database.Database): Set<string> {
  const rows = raw.prepare(`SELECT tag FROM ${MIGRATIONS_TABLE}`).all() as { tag: string }[]
  return new Set(rows.map((r) => r.tag))
}

// 基线检测（升级兼容，勿删）：
//   引入记账表之前创建的历史库，schema 已就绪但没有 __mwo_migrations 记录。
//   此时若直接重放迁移会撞“表已存在”。策略：当记账表为空但库中已存在标志表（files）
//   时，判定该库已处于当前 journal 版本，仅补写记账行、不重复执行 SQL。
//   判据选用 files 表：它是 0000 迁移建立的核心表，凡有数据的库必存在。
function needsBaseline(raw: Database.Database, done: Set<string>): boolean {
  if (done.size > 0) return false
  const sentinel = raw
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='files'")
    .get()
  return Boolean(sentinel)
}

function runMigrations(raw: Database.Database, migrationsDir: string): void {
  const journalPath = join(migrationsDir, 'meta', '_journal.json')
  if (!existsSync(journalPath)) return
  const journal = JSON.parse(readFileSync(journalPath, 'utf-8')) as {
    entries: JournalEntry[]
  }
  const entries = [...(journal.entries ?? [])].sort((a, b) => a.idx - b.idx)

  ensureMigrationsTable(raw)
  const done = appliedTags(raw)
  const recordApplied = raw.prepare(
    `INSERT INTO ${MIGRATIONS_TABLE} (tag, applied_at) VALUES (?, ?)`
  )

  // 历史库：补记账，跳过执行。
  if (needsBaseline(raw, done)) {
    const baselined = raw.transaction(() => {
      for (const entry of entries) {
        if (!existsSync(join(migrationsDir, `${entry.tag}.sql`))) continue
        recordApplied.run(entry.tag, Date.now())
      }
    })
    baselined()
    return
  }

  for (const entry of entries) {
    if (done.has(entry.tag)) continue // 已应用，跳过（幂等）
    const sqlPath = join(migrationsDir, `${entry.tag}.sql`)
    if (!existsSync(sqlPath)) continue
    const sql = readFileSync(sqlPath, 'utf-8')
    const statements = sql
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean)
    // 单事务：迁移全部语句 + 记账行一起提交，任一失败则整体回滚。
    const applyOne = raw.transaction(() => {
      for (const statement of statements) {
        raw.exec(statement)
      }
      recordApplied.run(entry.tag, Date.now())
    })
    applyOne()
  }
}

export function openDatabase(filename: string): DbHandle {
  // nativeBinding：仅在纯 Node（vitest）下注入 Node-ABI 副本，Electron 运行时为 undefined 走默认解析。
  const nativeBinding = resolveNativeBinding()
  const raw = new Database(filename, nativeBinding ? { nativeBinding } : undefined)
  raw.pragma('journal_mode = WAL')
  raw.pragma('foreign_keys = ON')
  runMigrations(raw, resolveMigrationsDir())
  const db = drizzle(raw, { schema })
  return {
    db,
    raw,
    close: () => raw.close()
  }
}

export { resolveMigrationsDir }

export function listMigrationTags(migrationsDir = resolveMigrationsDir()): string[] {
  const dir = join(migrationsDir)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
}
