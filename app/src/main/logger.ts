import pino, { type Logger, type LoggerOptions } from 'pino'

const SENSITIVE_KEYS = [
  'apiKey',
  'api_key',
  'apikey',
  'token',
  'accessToken',
  'access_token',
  'refreshToken',
  'password',
  'secret',
  'authorization',
  'content',
  'text',
  'body',
  'prompt',
  'messages',
  'documentText',
  'fileContent'
] as const

const REDACT_PATHS = SENSITIVE_KEYS.flatMap((key) => [
  key,
  `*.${key}`,
  `*.*.${key}`
])

function baseOptions(): LoggerOptions {
  const level = process.env['MWO_LOG_LEVEL'] ?? (process.env['NODE_ENV'] === 'production' ? 'info' : 'debug')
  return {
    level,
    redact: {
      paths: REDACT_PATHS,
      censor: '[REDACTED]'
    },
    base: { app: 'my-work-office' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label) {
        return { level: label }
      }
    }
  }
}

export const logger: Logger = pino(baseOptions())

export function createLogger(scope: string): Logger {
  return logger.child({ scope })
}
