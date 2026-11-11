import type { AjaxResult } from '@common/contracts/AjaxResult'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes, errorMessages } from '@common/errors/ErrorCodes'

export class IpcErrorMapper {
  /**
   * @returns 已知 `AppException` 保留 `code` 与 `message`。其他异常返回系统码，不含原文或调用栈。
   */
  map(error: unknown): AjaxResult {
    if (error instanceof AppException) {
      return {
        code: error.code,
        msg: /[A-Za-z]:[\\/]|[\\/]/.test(error.message)
          ? errorMessages[ErrorCodes.internalError]
          : error.message
      }
    }
    return {
      code: ErrorCodes.internalError,
      msg: errorMessages[ErrorCodes.internalError]
    }
  }
}
