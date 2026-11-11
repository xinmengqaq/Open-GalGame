import { getStream } from 'file-stream-rotator'
import { join } from 'node:path'
import pino, { type Logger } from 'pino'

import type { RuntimeConfig } from '@common/config/RuntimeConfig'
import type { LogContext } from '@common/logging/LogContext'
import type { LoggerGateway } from '@common/logging/LoggerGateway'

export class PinoLoggerGatewayImpl implements LoggerGateway {
  private readonly logger: Logger
  private readonly stream: ReturnType<typeof getStream>
  private closing?: Promise<void>
  /** 建立中文诊断日志，轮转与保留交由库处理。 */
  constructor(directory: string, config: Readonly<RuntimeConfig>) {
    this.stream = getStream({
      filename: join(directory, 'diagnostic-%DATE%'),
      frequency: 'daily',
      date_format: 'Y-M-D',
      size: `${config.logMaxBytes / 1024}k`,
      max_logs: `${config.logRetentionDays}d`,
      audit_file: join(directory, 'rotation-audit.json'),
      extension: '.jsonl',
      end_stream: true,
      verbose: false
    })
    this.stream.on('error', () => {
      process.stderr.write('诊断日志写入失败\n')
    })
    this.logger = pino({ level: config.logLevel, base: undefined }, this.stream)
  }
  debug(message: string, context?: LogContext): void {
    this.record('debug', message, context)
  }
  info(message: string, context?: LogContext): void {
    this.record('info', message, context)
  }
  warn(message: string, context?: LogContext): void {
    this.record('warn', message, context)
  }
  error(message: string, context?: LogContext): void {
    this.record('error', message, context)
  }
  close(): Promise<void> {
    this.closing ??= new Promise((resolve) => {
      this.stream.once('finish', resolve)
      this.stream.once('error', resolve)
      this.stream.end('')
    })
    return this.closing
  }
  /**
   * 按统一结构写出日志，写失败只落 stderr，不改变提交结果。
   * @param context - 关联标识等上下文，缺省为空对象。
   */
  private record(
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    context: LogContext = {}
  ): void {
    const {
      requestId,
      operationId,
      projectId,
      stage,
      errorCode,
      errorName,
      causeNames,
      causeCodes,
      statuses,
      diagnosticRef,
      category,
      recordedDiagnosticRef,
      recordedCategory,
      durationMs
    } = context
    try {
      this.logger[level](
        {
          requestId,
          operationId,
          projectId,
          stage,
          errorCode,
          errorName,
          causeNames,
          causeCodes,
          statuses,
          diagnosticRef,
          category,
          recordedDiagnosticRef,
          recordedCategory,
          durationMs
        },
        message
      )
    } catch {
      process.stderr.write('诊断日志写入失败\n')
    }
  }
}
