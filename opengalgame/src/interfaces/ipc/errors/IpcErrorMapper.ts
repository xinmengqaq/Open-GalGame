import { AppException } from '@common/errors/AppException'
import { ErrorCodes, errorMessages } from '@common/errors/ErrorCodes'
import type { FailureResult } from '../../contracts/FailureResultSchema'

export class IpcErrorMapper {
  /**
   * @returns 已知 `AppException` 原样保留 `code`、安全消息与可选 `reason`。
   * 其他异常返回系统码，不含原文或调用栈。
   */
  map(error: unknown): FailureResult {
    if (error instanceof AppException) {
      const msg = /[A-Za-z]:[\\/]|[\\/]/.test(error.message)
        ? errorMessages[ErrorCodes.internalError]
        : error.message
      return error.reason === undefined
        ? { code: error.code, msg }
        : { code: error.code, msg, reason: error.reason }
    }
    return {
      code: ErrorCodes.internalError,
      msg: errorMessages[ErrorCodes.internalError]
    }
  }
}
