import type { RequestContextDTO } from '../../dto/RequestContextDTO'
import { IpcErrorMapper } from './IpcErrorMapper'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import type { LogContext } from '@common/logging/LogContext'
import type { LoggerGateway } from '@common/logging/LoggerGateway'

export class IpcExceptionHandler {
  constructor(
    private readonly logger: LoggerGateway,
    private readonly errors: IpcErrorMapper
  ) {}

  async handle<T>(
    context: RequestContextDTO,
    action: () => AjaxResult<T> | Promise<AjaxResult<T>>
  ): Promise<AjaxResult<T>> {
    try {
      return await action()
    } catch (error) {
      const result = this.errors.map(error)
      this.recordFailure(context, result.code)
      return result
    }
  }

  private recordFailure(context: RequestContextDTO, errorCode: number): void {
    const logContext: LogContext = {
      requestId: context.requestId,
      errorCode
    }
    if (context.operationId !== undefined) {
      logContext.operationId = context.operationId
    }
    try {
      this.logger.error('请求执行失败', logContext)
    } catch {
    }
  }
}
