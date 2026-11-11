import type { LogContext } from './LogContext'

export interface LoggerGateway {
  /**
   * @param message - 中文诊断消息，不传用户正文或供应商原文。
   * @param context - 关联字段。不放正文、请求体或凭据。
   */
  debug(message: string, context?: LogContext): void
  info(message: string, context?: LogContext): void
  warn(message: string, context?: LogContext): void
  error(message: string, context?: LogContext): void
}
