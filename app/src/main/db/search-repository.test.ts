import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type DbHandle } from './connection'
import { SqliteFtsSearchRepository, toFtsPhraseQuery } from './search-repository'

// FTS5 词法守卫测试（T-S2-08 左栏搜索）：在真实迁移 schema（trigram 分词，
// 架构 §4）上验证「用户输入一律按字面短语检索」，杜绝引号/操作符引发的
// fts5: syntax error 与布尔语义劫持。

let workDir: string
let handle: DbHandle
let repo: SqliteFtsSearchRepository

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'mwo-fts-'))
  handle = openDatabase(join(workDir, 'test.db'))
  repo = new SqliteFtsSearchRepository(handle.raw)
})

afterEach(() => {
  handle.close()
  rmSync(workDir, { recursive: true, force: true })
})

describe('toFtsPhraseQuery', () => {
  it('wraps input as a double-quoted literal phrase', () => {
    expect(toFtsPhraseQuery('revenue')).toBe('"revenue"')
  })

  it('escapes embedded double quotes by doubling them', () => {
    expect(toFtsPhraseQuery('say "hi"')).toBe('"say ""hi"""')
  })

  it('trims surrounding whitespace', () => {
    expect(toFtsPhraseQuery('  padded  ')).toBe('"padded"')
  })

  it('neutralizes FTS5 operators into literals', () => {
    expect(toFtsPhraseQuery('NEAR(a b)')).toBe('"NEAR(a b)"')
    expect(toFtsPhraseQuery('a AND b NOT c')).toBe('"a AND b NOT c"')
  })
})

describe('SqliteFtsSearchRepository.query guard', () => {
  it('returns [] for empty or whitespace-only input instead of throwing', () => {
    repo.indexFile('f1', 'quarterly revenue grew strongly', 'report')
    expect(repo.query('')).toEqual([])
    expect(repo.query('   ')).toEqual([])
  })

  it('treats operator-looking keywords as literal phrases', () => {
    repo.indexFile('f1', 'NEAR(a b) is fts5 query syntax', 'memo')
    // 未守卫时裸 NEAR(...) 会让 FTS5 抛 fts5: syntax error near "NEAR"。
    expect(() => repo.query('NEAR(a b)')).not.toThrow()
    expect(repo.query('NEAR(a b)').map((h) => h.fileId)).toEqual(['f1'])
  })

  it('does not reinterpret bare AND as a boolean operator', () => {
    repo.indexFile('f1', 'revenue AND profit summary', 'ledger')
    repo.indexFile('f2', 'revenue grew, profit later', 'notes')
    // 守卫后 "revenue AND" 是字面短语：仅 f1 连续包含该序列；
    // 若被解释为布尔与，不含该字面序列的 f2 也会命中。
    expect(repo.query('revenue AND').map((h) => h.fileId)).toEqual(['f1'])
  })

  it('matches quoted fragments literally after escaping', () => {
    repo.indexFile('f1', 'he said "ok" right then', 'notes')
    expect(repo.query('said "ok" right').map((h) => h.fileId)).toEqual(['f1'])
  })

  it('matches CJK substrings via the trigram tokenizer', () => {
    repo.indexFile('f1', '第三季度营业收入同比大幅增长', '季度报告')
    repo.indexFile('f2', 'holiday party planning notes', 'memo')
    expect(repo.query('营业收入').map((h) => h.fileId)).toEqual(['f1'])
  })

  it('hits the metadata column too (file-name search path)', () => {
    repo.indexFile('f1', 'quarterly numbers', '年度总结.docx words:120')
    expect(repo.query('年度总结').map((h) => h.fileId)).toEqual(['f1'])
  })
})
