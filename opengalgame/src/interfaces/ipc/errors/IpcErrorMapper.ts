import { AppException } from '@common/errors/AppException'
import { ErrorCodes, errorMessages } from '@common/errors/ErrorCodes'
import type { FailureResult } from '../../contracts/FailureResultSchema'

export class IpcErrorMapper {
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
