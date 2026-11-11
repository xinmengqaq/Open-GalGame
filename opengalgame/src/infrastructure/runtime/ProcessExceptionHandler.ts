import type { LoggerGateway } from '@common/logging/LoggerGateway'

export function registerProcessExceptionHandler(
  logger: LoggerGateway,
  terminate: () => void
): () => void {
  const fail = (): void => {
    logger.error('主进程发生未处理故障，正在退出')
    terminate()
  }
  process.on('uncaughtException', fail)
  process.on('unhandledRejection', fail)
  return () => {
    process.removeListener('uncaughtException', fail)
    process.removeListener('unhandledRejection', fail)
  }
}
