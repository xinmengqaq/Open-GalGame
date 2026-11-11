import { isAjaxResult } from '../contracts/AjaxResultSchema'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import { ErrorCodes, errorMessages } from '@common/errors/ErrorCodes'

/**
 * @returns 通信失败码。这不是主进程确认的失败，调用方不要据此重试写入。
 */
export function communicationFailureResult(): AjaxResult<never> {
  return {
    code: ErrorCodes.communicationFailed,
    msg: errorMessages[ErrorCodes.communicationFailed]
  }
}

/**
 * 把列表查询的传输中断或响应结构不符记成读取失败。
 * @returns 通信失败码与列表读取提示，不含主进程关联 ID。
 */
export function listProjectsFailureResult(): AjaxResult<never> {
  return {
    code: ErrorCodes.communicationFailed,
    msg: '项目列表加载失败，请重试'
  }
}

/**
 * 调用跨进程操作，并把中断或结构不符收成通信失败。
 * @returns 结构合格的原响应，否则为通信失败结果。
 */
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
