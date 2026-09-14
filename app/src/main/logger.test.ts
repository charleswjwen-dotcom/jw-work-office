import { describe, it, expect } from 'vitest'
import pino from 'pino'
import { createLogger } from './logger'

describe('logger redaction', () => {
  it('createLogger 附带 scope 且可正常写日志', () => {
    const log = createLogger('unit-test')
    expect(() => log.info({ event: 'probe' }, 'ok')).not.toThrow()
  })

  it('敏感字段（密钥/文档内容）被脱敏，不落明文', () => {
    const lines: string[] = []
    const sink = pino(
      {
        redact: {
          paths: ['apiKey', 'token', 'content', 'text', 'prompt', 'messages', '*.apiKey', '*.content'],
          censor: '[REDACTED]'
        }
      },
      {
        write(chunk: string) {
          lines.push(chunk)
        }
      }
    )

    sink.info(
      {
        apiKey: 'sk-live-should-not-appear',
        token: 'bearer-secret',
        content: '这是文档正文不应出现在日志',
        prompt: '用户输入的敏感提示词',
        provider: 'mock',
        tokensIn: 42
      },
      'sensitive probe'
    )

    const out = lines.join('')
    expect(out).not.toContain('sk-live-should-not-appear')
    expect(out).not.toContain('bearer-secret')
    expect(out).not.toContain('这是文档正文不应出现在日志')
    expect(out).not.toContain('用户输入的敏感提示词')
    expect(out).toContain('[REDACTED]')
    expect(out).toContain('"provider":"mock"')
    expect(out).toContain('"tokensIn":42')
  })
})
