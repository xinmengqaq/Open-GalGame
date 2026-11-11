import type { AjaxResult } from '@common/contracts/AjaxResult'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes, errorMessages } from '@common/errors/ErrorCodes'

export interface FailureState {
  code: number
  msg: string
}

/**
 * 取统一响应中的数据，失败响应转成异常。
 * 具名客户端把传输失败也收成失败响应、从不 reject，数据层需要异常才判得出失败。
 * @throws {AppException} 响应不是成功码或缺少数据。
 */
export function requireSuccess<TData>(result: AjaxResult<TData>): TData {
  if (result.code !== ErrorCodes.success || result.data === undefined)
    throw new AppException({ code: result.code, msg: result.msg })
  return result.data
}

/**
 * 取异常携带的失败码与安全消息。
 * @returns 可展示的失败；不是本应用异常时给出系统失败码，不回落成空提示。
 */
export function failureOf(error: unknown): FailureState {
  return error instanceof AppException
    ? { code: error.code, msg: error.message }
    : { code: ErrorCodes.internalError, msg: errorMessages[ErrorCodes.internalError] }
}
