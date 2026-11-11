import type { RequestContextDTO } from '../../dto/RequestContextDTO'
import { IpcErrorMapper } from './IpcErrorMapper'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import type { LogContext } from '@common/logging/LogContext'
import type { LoggerGateway } from '@common/logging/LoggerGateway'

export class IpcExceptionHandler {
  private readonly errors = new IpcErrorMapper()

  /**
   * @param logger - 失败日志出口。
   */
  constructor(private readonly logger: LoggerGateway) {}

  /**
   * @param context - 进程内关联信息，用于失败日志。
   * @param action - 返回统一响应的操作。它自己返回的结果原样交回。
   * @returns 操作结果，或映射后的失败响应。抛出的失败只记录一次。
   */
  async handle<T>(
    context: RequestContextDTO,
    action: () => AjaxResult<T> | Promise<AjaxResult<T>>
  ): Promise<AjaxResult<T>> {
    try {
      return await action()
    } catch (error) {
      const result = this.errors.map(error)
      this.recordFailure(context, result.code)
      return { code: result.code, msg: result.msg }
    }
  }

  /**
   * 记录失败日志。日志失败不改变已经形成的响应。
   * @param context - 进程内关联信息，用于失败日志。
   * @param errorCode - 失败码。
   */
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
    } catch {}
  }
}
