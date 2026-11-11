import type { LangGraphRunnableConfig } from '@langchain/langgraph'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { waitWithSignal } from '@infrastructure/ai/execution/executionErrors'
import { recordConfirmedFailure } from '@infrastructure/ai/middleware/executionMiddleware'
import type { WebGalGenerationStateValue } from '../WebGalGenerationState'
import { contextOnly, correctableIssueSignature } from './candidateWriteAndValidation'
import type { WebGalGenerationGraphDependencies } from './graphDependencies'
import { budgetSnapshot } from './settlement'

export function createRepairNode(deps: WebGalGenerationGraphDependencies) {
  return async (state: WebGalGenerationStateValue) => {
    const issues = state.execution.artifactValidation?.issues ?? []
    const issueKey = correctableIssueSignature(issues)
    const sameFacts =
      (state.correctableIssueKey ?? '') !== '' && state.correctableIssueKey === issueKey
    const maxCorrections = state.execution.policy.maxCorrections
    // 旧检查点没有修正次数时按已耗尽处理，不能重新开始无限自动修正。
    const correctionsUsed =
      (state.execution.budget.correctionsUsed as number | undefined) ?? maxCorrections
    if (contextOnly(issues) || correctionsUsed >= maxCorrections)
      return {
        status: 'waiting' as const,
        needsDecision: true,
        questions: [],
        repairRequested: false,
        correctableIssueKey: '',
        execution: {
          ...state.execution,
          step: undefined
        }
      }
    if (sameFacts) {
      const stalled = new AppException({
        code: ErrorCodes.operationConflict,
        msg: '重复修正没有改变可修正问题'
      })
      if (!deps.budget) throw stalled
      recordConfirmedFailure(deps.budget, stalled)
    }
    const execution = {
      ...state.execution,
      step: 'correcting' as const,
      budget: {
        ...state.execution.budget,
        correctionsUsed: ((state.execution.budget.correctionsUsed as number | undefined) ?? 0) + 1
      }
    }
    await deps.runtime?.publishProgress({
      step: 'correcting',
      attempt: execution.attempt + 1,
      budget: execution.budget,
      candidateSnapshotId: execution.candidateSnapshotId,
      artifactValidation: state.execution.artifactValidation
    })
    return {
      mode: 'repair' as const,
      status: 'working' as const,
      repairRequested: false,
      correctableIssueKey: issueKey,
      execution
    }
  }
}

export function createRetryNode(deps: WebGalGenerationGraphDependencies) {
  return async (state: WebGalGenerationStateValue, config: LangGraphRunnableConfig) => {
    if (!deps.budget)
      throw new AppException({ code: ErrorCodes.internalError, msg: '只读历史图不能执行生成' })
    const next = (state.retryCount ?? 0) + 1
    const delay = Math.min(500 * 2 ** (next - 1), 4000)
    const message = state.outcome?.kind === 'modelError' ? state.outcome.message : '生成调用失败'
    // 重试次数只用于退避和观测，不单独形成失败终态。
    if (config.signal?.aborted || deps.budget.remainingActiveMs() < delay)
      return {
        status: 'failed' as const,
        failureClass: 'modelTransient' as const,
        failureReason: state.failureReason,
        failureMessage: message,
        outcome: {
          kind: 'modelError' as const,
          failureClass: 'modelTransient' as const,
          retryable: false,
          message
        }
      }
    await deps.runtime?.publishProgress({
      step: 'generating',
      attempt: state.execution.attempt,
      budget: budgetSnapshot(state.execution, deps.budget),
      retryCount: next
    })
    await waitWithSignal(delay, config.signal)
    return { retryCount: next, outcome: undefined }
  }
}
