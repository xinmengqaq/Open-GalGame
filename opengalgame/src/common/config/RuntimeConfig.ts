export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const

export type LogLevel = (typeof LOG_LEVELS)[number]

export interface RuntimeConfig {
  logLevel: LogLevel
  logMaxBytes: number
  logRetentionDays: number
  requestTimeoutMs: number
}
