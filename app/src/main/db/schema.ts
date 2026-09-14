import { sql } from 'drizzle-orm'
import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex
} from 'drizzle-orm/sqlite-core'

export const workspaces = sqliteTable('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  settings: text('settings', { mode: 'json' })
})

export const files = sqliteTable(
  'files',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    type: text('type', { enum: ['word', 'excel', 'ppt'] }).notNull(),
    path: text('path').notNull(),
    size: integer('size').notNull().default(0),
    pageCount: integer('page_count'),
    sheetCount: integer('sheet_count'),
    tags: text('tags', { mode: 'json' }),
    thumbnail: text('thumbnail'),
    currentVersionId: text('current_version_id'),
    contentHash: text('content_hash'),
    importedAt: integer('imported_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    modifiedAt: integer('modified_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    remoteId: text('remote_id'),
    etag: text('etag'),
    syncState: text('sync_state', {
      enum: ['local', 'synced', 'dirty', 'conflict']
    }).default('local'),
    updatedBy: text('updated_by')
  },
  (t) => ({
    byWorkspaceType: index('idx_files_workspace_type').on(t.workspaceId, t.type)
  })
)

export const versions = sqliteTable(
  'versions',
  {
    id: text('id').primaryKey(),
    fileId: text('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    triggerCommand: text('trigger_command'),
    author: text('author', { enum: ['ai', 'user', 'external'] }),
    changeSummary: text('change_summary'),
    storageType: text('storage_type', { enum: ['full', 'diff'] }).notNull(),
    snapshotPath: text('snapshot_path'),
    changeSetId: text('change_set_id'),
    parentVersionId: text('parent_version_id'),
    remoteId: text('remote_id'),
    etag: text('etag'),
    syncState: text('sync_state', {
      enum: ['local', 'synced', 'dirty', 'conflict']
    }).default('local'),
    updatedBy: text('updated_by')
  },
  (t) => ({
    byFileSeq: uniqueIndex('idx_versions_file_seq').on(t.fileId, t.seq)
  })
)

export const changeSets = sqliteTable(
  'change_sets',
  {
    id: text('id').primaryKey(),
    fileId: text('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    source: text('source', { enum: ['ai', 'manual', 'external'] })
      .notNull()
      .default('ai'),
    sourceCommand: text('source_command'),
    status: text('status', {
      enum: ['pending', 'applied', 'discarded', 'partial', 'stale']
    }).notNull(),
    changes: text('changes', { mode: 'json' }),
    changesPath: text('changes_path'),
    remoteId: text('remote_id'),
    etag: text('etag'),
    syncState: text('sync_state', {
      enum: ['local', 'synced', 'dirty', 'conflict']
    }).default('local'),
    updatedBy: text('updated_by')
  },
  (t) => ({
    byFileStatus: index('idx_change_sets_file_status').on(t.fileId, t.status)
  })
)

export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  title: text('title'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`)
})

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['system', 'user', 'assistant', 'tool'] }).notNull(),
    content: text('content'),
    toolCalls: text('tool_calls', { mode: 'json' }),
    changeSetId: text('change_set_id'),
    resultCards: text('result_cards', { mode: 'json' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`)
  },
  (t) => ({
    byConversation: index('idx_messages_conversation').on(t.conversationId)
  })
)

export const userPreferences = sqliteTable('user_preferences', {
  id: text('id').primaryKey(),
  scope: text('scope', { enum: ['global', 'workspace', 'filetype'] }).notNull(),
  rule: text('rule').notNull(),
  hitCount: integer('hit_count').notNull().default(0),
  weight: integer('weight').notNull().default(0),
  editable: integer('editable', { mode: 'boolean' }).notNull().default(true),
  deletable: integer('deletable', { mode: 'boolean' }).notNull().default(true)
})

export const modelConfigs = sqliteTable('model_configs', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  protocol: text('protocol').notNull(),
  baseUrl: text('base_url'),
  model: text('model').notNull(),
  apiKeyRef: text('api_key_ref'),
  isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false)
})

export const usageRecords = sqliteTable('usage_records', {
  id: text('id').primaryKey(),
  modelId: text('model_id')
    .notNull()
    .references(() => modelConfigs.id, { onDelete: 'cascade' }),
  tokensIn: integer('tokens_in').notNull().default(0),
  tokensOut: integer('tokens_out').notNull().default(0),
  callCount: integer('call_count').notNull().default(0),
  cost: integer('cost').notNull().default(0),
  timestamp: integer('timestamp', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`)
})

export const knowledgeEntries = sqliteTable(
  'knowledge_entries',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    sourceFileId: text('source_file_id').references(() => files.id, {
      onDelete: 'set null'
    }),
    sourceVersionId: text('source_version_id'),
    category: text('category').notNull(),
    entryType: text('entry_type', {
      enum: ['summary', 'structure', 'style', 'tag']
    }).notNull(),
    title: text('title').notNull(),
    content: text('content'),
    payload: text('payload', { mode: 'json' }),
    tags: text('tags', { mode: 'json' }),
    refCount: integer('ref_count').notNull().default(0),
    confidence: integer('confidence').notNull().default(0),
    status: text('status', { enum: ['suggested', 'active', 'disabled'] })
      .notNull()
      .default('suggested'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`)
  },
  (t) => ({
    byWorkspaceCategory: index('idx_knowledge_workspace_category').on(
      t.workspaceId,
      t.category,
      t.entryType
    )
  })
)

// FTS5 全文检索虚表（架构 §4 fts_files(file_id, content, metadata)）。
// 分词器选 trigram 而非默认 unicode61：unicode61 会把连续中文当作单个 token，
// 导致"营业收入"这类子串检索不到（中文无空格分词）。trigram 按 3-gram 切分，
// 对中英文子串检索都友好，代价是查询词需 ≥3 个字符、索引体积略增——
// 对本地办公文档规模完全可接受。SQLite 3.34+ 内置 trigram（better-sqlite3@13 满足）。
export const FTS_FILES_CREATE_SQL = `CREATE VIRTUAL TABLE IF NOT EXISTS fts_files USING fts5(
  file_id UNINDEXED,
  content,
  metadata,
  tokenize = 'trigram'
);`

export const schema = {
  workspaces,
  files,
  versions,
  changeSets,
  conversations,
  messages,
  userPreferences,
  modelConfigs,
  usageRecords,
  knowledgeEntries
}

