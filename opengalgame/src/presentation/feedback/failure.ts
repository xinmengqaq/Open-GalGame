import type { AjaxResult } from '@common/contracts/AjaxResult'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes, errorMessages } from '@common/errors/ErrorCodes'

export interface FailureState {
  code: number
  msg: string
  reason?: string
}

export function requireSuccess<TData>(result: AjaxResult<TData>): TData {
  if (result.code !== ErrorCodes.success || result.data === undefined)
    throw new AppException({
      code: result.code,
      msg: result.msg,
      ...(result.reason === undefined ? {} : { reason: result.reason })
    })
  return result.data
}

export function failureOf(error: unknown): FailureState {
  return error instanceof AppException
    ? {
        code: error.code,
        msg: error.message,
        ...(error.reason === undefined ? {} : { reason: error.reason })
      }
    : { code: ErrorCodes.internalError, msg: errorMessages[ErrorCodes.internalError] }
}
