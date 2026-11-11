import { ErrorCodes } from '@common/errors/ErrorCodes'
import {
  SceneGenerationRunFailed,
  type FailureClass,
  type RunFailureReason
} from '@application/scene-generation/models/SceneGenerationRunOutcome'
import { AppException } from '@common/errors/AppException'
import { normalizeAgentError, isRetryable, unwind } from '@infrastructure/ai/middleware/retryPolicy'
import type { WebGalGenerationStateValue } from './WebGalGenerationState'

export type RunRoute =
  'validateCandidate' | 'finalize' | 'retry' | 'repair' | 'waitForHuman' | 'settle'

export type RunErrorClassification = {
  failureClass: FailureClass
  reason?: RunFailureReason
  message: string
  retryable: boolean
}

/**
 * 节点自身的终态失败。工作流捕获后从原因链生成公开失败事实；
 * 节点不构造带窄字段的公开错误，也不把失败压成状态。
 */
export class RunFailure extends AppException {
  readonly failureClass: FailureClass
  readonly reason?: RunFailureReason

  constructor(input: {
    failureClass: FailureClass
    reason?: RunFailureReason
    message: string
    cause?: unknown
  }) {
    super({
      code: failureCodeOf(input.failureClass),
      msg: input.message,
      ...(input.cause === undefined ? {} : { cause: input.cause })
    })
    this.name = 'RunFailure'
    this.failureClass = input.failureClass
    this.reason = input.reason
  }
}

/**
 * 把节点抛出的技术失败归入可路由的分类。
 * 取消返回 undefined，由调用方重新抛出交给统一取消结算。
 * @param error - 节点捕获的失败。
 * @param signal - 本次运行的合并停止信号。
 * @returns 分类事实；取消或中止时为 undefined。
 */
export function classifyRunError(
  error: unknown,
  signal: AbortSignal | undefined
): RunErrorClassification | undefined {
  const chain = unwind(error)
  if (
    signal?.aborted ||
    chain.some(
      (item) =>
        isNamedError(item, ['AbortError', 'APIUserAbortError']) ||
        (typeof item === 'object' &&
          item !== null &&
          'message' in item &&
          item.message === '执行已取消')
    )
  )
    return undefined
  const typed = chain.find((item): item is RunFailure => item instanceof RunFailure)
  if (typed)
    return {
      failureClass: typed.failureClass,
      ...(typed.reason ? { reason: typed.reason } : {}),
      message: typed.message,
      retryable: false
    }
  const recorded = chain.find(
    (item): item is SceneGenerationRunFailed => item instanceof SceneGenerationRunFailed
  )
  if (recorded)
    return {
      failureClass: recorded.failureClass,
      ...(recorded.reason ? { reason: recorded.reason } : {}),
      message: recorded.message,
      retryable: false
    }
  const normalized = normalizeAgentError(error)
  const message = normalized.message
  if (chain.some((item) => isNamedError(item, ['ErrorBudgetExhausted', 'GraphRecursionError'])))
    return { failureClass: 'noProgress', message, retryable: false }
  if (chain.some((item) => isNamedError(item, ['AttemptTimedOut'])))
    return { failureClass: 'modelTransient', message, retryable: true }
  if (chain.some((item) => isNamedError(item, ['ActiveLimitExceeded'])))
    return { failureClass: 'modelTransient', message, retryable: false }
  switch (normalized.diagnosticCategory) {
    case 'auth':
      return { failureClass: 'modelAuth', message, retryable: false }
    case 'request':
      return { failureClass: 'modelRejected', message, retryable: false }
    case 'context':
      return { failureClass: 'contextOverflow', message, retryable: false }
    case 'output-truncated':
      return {
        failureClass: 'outputContract',
        reason: 'outputTruncated',
        message,
        retryable: false
      }
    case 'missing-structured-result':
      return {
        failureClass: 'outputContract',
        reason: 'missingStructuredResult',
        message,
        retryable: false
      }
    case 'structured-output':
      return {
        failureClass: 'outputContract',
        reason: 'structuredOutput',
        message,
        retryable: false
      }
    case 'completion':
      return {
        failureClass: 'outputContract',
        reason: 'missingCandidateWrite',
        message,
        retryable: false
      }
    case 'no-progress':
      return {
        failureClass: 'noProgress',
        reason: 'noInformationGain',
        message,
        retryable: false
      }
    default:
      return isRetryable(error)
        ? { failureClass: 'modelTransient', message, retryable: true }
        : { failureClass: 'internal', message, retryable: false }
  }
}

/** 准备节点只校验输入是否足够开始生成。 */
export function prepareRoute(
  state: WebGalGenerationStateValue
): 'writeCandidate' | 'validateCandidate' | 'settle' {
  if (state.status === 'failed') return 'settle'
  if (state.mode === 'validate') return 'validateCandidate'
  return 'writeCandidate'
}

/** 写入候选后按本次终态动作决定下一步。 */
export function composeRoute(state: WebGalGenerationStateValue): RunRoute {
  if (state.status === 'failed') return 'settle'
  const outcome = state.outcome
  if (!outcome) return 'settle'
  if (outcome.kind === 'questions' || outcome.kind === 'blocked') return 'waitForHuman'
  if (outcome.kind === 'finalize') return 'finalize'
  if (outcome.kind === 'modelError') return outcome.retryable ? 'retry' : 'settle'
  if (outcome.kind === 'candidate') return 'validateCandidate'
  if (
    outcome.kind === 'contractError' &&
    outcome.degraded &&
    (outcome.candidateSnapshotId ?? state.execution.candidateSnapshotId)
  )
    return 'validateCandidate'
  return 'settle'
}

/** 收尾提交后回到校验，或等待人工，或失败。 */
export function finalizeRoute(state: WebGalGenerationStateValue): RunRoute {
  if (state.status === 'failed') return 'settle'
  const outcome = state.outcome
  if (!outcome) return 'settle'
  if (outcome.kind === 'blocked') return 'waitForHuman'
  if (outcome.kind === 'candidate') return 'validateCandidate'
  if (
    outcome.kind === 'contractError' &&
    outcome.degraded &&
    (outcome.candidateSnapshotId ?? state.execution.candidateSnapshotId)
  )
    return 'validateCandidate'
  return 'settle'
}

/** 校验节点：要修正就去修正，要决策就等待，其余正常结束。 */
export function validateRoute(
  state: WebGalGenerationStateValue
): 'repair' | 'waitForHuman' | 'end' {
  if (state.repairRequested === true) return 'repair'
  if (state.status === 'waiting') return 'waitForHuman'
  return 'end'
}

/** 修正节点：到上限或只有上下文问题时等待，否则继续写候选。 */
export function repairRoute(state: WebGalGenerationStateValue): 'writeCandidate' | 'waitForHuman' {
  return state.status === 'waiting' ? 'waitForHuman' : 'writeCandidate'
}

/** 技术重试：失败结算或再次写入候选。 */
export function retryRoute(state: WebGalGenerationStateValue): 'writeCandidate' | 'settle' {
  return state.status === 'failed' ? 'settle' : 'writeCandidate'
}

/** 人工回复后：校验模式回到校验，其余回到生成。 */
export function waitForHumanRoute(
  state: WebGalGenerationStateValue
): 'writeCandidate' | 'validateCandidate' {
  return state.mode === 'validate' ? 'validateCandidate' : 'writeCandidate'
}

/** 失败分类到应用错误码的固定映射。 */
export function failureCodeOf(failureClass: FailureClass): number {
  if (failureClass === 'internal') return ErrorCodes.internalError
  if (failureClass === 'modelAuth') return ErrorCodes.forbidden
  if (
    failureClass === 'modelRejected' ||
    failureClass === 'contextOverflow' ||
    failureClass === 'inputInvalid'
  )
    return ErrorCodes.invalidRequest
  return ErrorCodes.operationConflict
}

function isNamedError(error: unknown, names: readonly string[]): boolean {
  return Boolean(
    error && typeof error === 'object' && 'name' in error && names.includes(String(error.name))
  )
}
