import { GraphRecursionError, isGraphInterrupt } from '@langchain/langgraph'
import { AppException } from '@common/errors/AppException'

import { ActiveLimitExceeded } from '@infrastructure/ai/execution/executionErrors'

import { WorkflowError } from '../WorkflowError'

/**
 * 按错误类型分类工作流失败。人工中断不是普通执行失败。
 * @param signal - 本次传给图的取消信号。
 * @returns 保留原始原因的技术错误。
 */
export function classifyWorkflowError(error: unknown, signal?: AbortSignal): WorkflowError {
  if (error instanceof WorkflowError) return error
  if (hasInterrupt(error)) {
    return new WorkflowError({
      category: 'interrupted',
      msg: '工作流正在等待人工处理',
      cause: error
    })
  }
  if (signal?.aborted && signal.reason instanceof ActiveLimitExceeded) {
    return new WorkflowError({
      category: 'timedOut',
      msg: '活跃执行时间已用尽',
      cause: error
    })
  }
  if (signal?.aborted) {
    return new WorkflowError({
      category: 'cancelled',
      msg: '执行已取消',
      cause: error ?? signal.reason
    })
  }
  if (error instanceof ActiveLimitExceeded) {
    return new WorkflowError({
      category: 'timedOut',
      msg: '活跃执行时间已用尽',
      cause: error
    })
  }
  if (error instanceof GraphRecursionError || hasName(error, 'GraphRecursionError')) {
    return new WorkflowError({
      category: 'executionFailed',
      msg: '工作流执行失败',
      cause: error
    })
  }
  if (error instanceof AppException) {
    return new WorkflowError({
      category: 'executionFailed',
      msg: error.message,
      code: error.code,
      cause: error
    })
  }
  return new WorkflowError({
    category: 'executionFailed',
    msg: '工作流执行失败',
    cause: error
  })
}

/** 沿 cause 链查找 LangGraph 人工中断。不读取错误文本。 */
function hasInterrupt(error: unknown): boolean {
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current && typeof current === 'object' && !seen.has(current)) {
    if (isGraphInterrupt(current)) return true
    seen.add(current)
    current = 'cause' in current ? current.cause : undefined
  }
  return false
}

/** 按库公开的稳定类名识别错误。不读取 message。 */
function hasName(error: unknown, name: string): boolean {
  return !!error && typeof error === 'object' && 'name' in error && error.name === name
}
