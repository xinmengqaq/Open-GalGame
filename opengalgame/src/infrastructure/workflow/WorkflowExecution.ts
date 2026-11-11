import { isAbsolute } from 'node:path'

import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { ExecutionBudget } from '@infrastructure/ai/execution/ExecutionBudget'
import type { AgentStreamObservation } from '@infrastructure/ai/streaming/AgentStreamEvent'

import { createWorkflowIdentity, type WorkflowIdentity } from './WorkflowIdentity'

export type WorkflowOperationPhase =
  'running' | 'waiting' | 'pendingRecovery' | 'finished' | 'cancelled' | 'failed'

export interface WorkflowExecution {
  identity: WorkflowIdentity
  budget: ExecutionBudget
  stateRoot: string
  recursionLimit: number
  signal?: AbortSignal
  observation?: AgentStreamObservation
}

/**
 * 校验运行上下文。预算、信号和观察配置只留在本次调用，不进入图状态。
 * @param input - 调用方提供的执行上下文。
 * @returns 身份已规范化的上下文。预算对象仍是调用方的那一个。
 * @throws {AppException} 身份、预算、递归限制或状态目录不合法。
 */
export function createWorkflowExecution(input: WorkflowExecution): WorkflowExecution {
  if (!(input.budget instanceof ExecutionBudget)) {
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: '工作流执行缺少执行预算' })
  }
  if (!Number.isSafeInteger(input.recursionLimit) || input.recursionLimit <= 0) {
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: '递归限制必须为正整数' })
  }
  if (typeof input.stateRoot !== 'string' || !isAbsolute(input.stateRoot)) {
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: '状态目录必须是绝对路径' })
  }
  if (input.signal !== undefined && !(input.signal instanceof AbortSignal)) {
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: '取消信号无效' })
  }
  const subscriptions = input.observation?.subscriptions
  if (subscriptions !== undefined && !Array.isArray(subscriptions)) {
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: '观察配置无效' })
  }
  if (subscriptions?.some((subscription) => typeof subscription?.onEvent !== 'function')) {
    throw new AppException({ code: ErrorCodes.invalidRequest, msg: '观察配置无效' })
  }
  return {
    identity: createWorkflowIdentity(input.identity),
    budget: input.budget,
    stateRoot: input.stateRoot,
    recursionLimit: input.recursionLimit,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
    ...(input.observation !== undefined ? { observation: input.observation } : {})
  }
}
