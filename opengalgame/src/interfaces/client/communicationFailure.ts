import { isAjaxResult } from '../contracts/AjaxResultSchema'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import { ErrorCodes, errorMessages } from '@common/errors/ErrorCodes'

export function communicationFailureResult(): AjaxResult<never> {
  return {
    code: ErrorCodes.communicationFailed,
    msg: errorMessages[ErrorCodes.communicationFailed]
  }
}

export function listProjectsFailureResult(): AjaxResult<never> {
  return {
    code: ErrorCodes.communicationFailed,
    msg: '项目列表加载失败，请重试'
  }
}

export async function invokeAjaxResult<T>(
  action: () => Promise<AjaxResult<T>>
): Promise<AjaxResult<T>> {
  try {
    const result = await action()
    return isAjaxResult(result) ? result : communicationFailureResult()
  } catch {
    return communicationFailureResult()
  }
}
