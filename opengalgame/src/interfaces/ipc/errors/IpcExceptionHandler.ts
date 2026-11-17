import type { RequestContextDTO } from '../../dto/RequestContextDTO'
import { IpcErrorMapper } from './IpcErrorMapper'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import type { LogContext } from '@common/logging/LogContext'
import type { LoggerGateway } from '@common/logging/LoggerGateway'

export class IpcExceptionHandler {
  /**
   * @param logger - 失败日志出口。
   * @param errors - 单一失败映射；由组合根显式注入。
   */
  constructor(
    private readonly logger: LoggerGateway,
    private readonly errors: IpcErrorMapper
  ) {}

  /**
   * @param context - 进程内关联信息，用于失败日志。
   * @param action - 返回统一响应的操作。它自己返回的结果原样交回。
   * @returns 操作结果，或映射后的失败响应。抛出的失败只映射一次并原样交回。
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
      return result
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
    } catch {
      // 日志出口失败不改变已经形成的失败响应；不重试、不向外抛出。
    }
  }
}
