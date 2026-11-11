import type {
  SceneGenerationBudget,
  SceneGenerationExecution
} from '@application/scene-generation/models/SceneGenerationExecution'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { ExecutionBudget } from '@infrastructure/ai/execution/ExecutionBudget'
import type { DurableEffectQuestion } from '@infrastructure/workflow/DurableEffectRecord'
import { writeDurableEffect } from '@infrastructure/workflow/execution/durableEffect'
import type { WebGalGenerationStateValue } from '../WebGalGenerationState'
import { RunFailure } from '../runFailureRouting'

/**
 * 失败结算只处理旧检查点或重试节点留下的状态事实。
 * 新终态失败由节点抛出原始错误，不在状态里复制失败事实。
 */
export function settleNode() {
  return (state: WebGalGenerationStateValue) => {
    throw new RunFailure({
      failureClass: state.failureClass ?? 'internal',
      ...(state.failureReason ? { reason: state.failureReason } : {}),
      message: state.failureMessage ?? '生成未完成'
    })
  }
}

export function budgetSnapshot(
  execution: SceneGenerationExecution,
  budget: ExecutionBudget
): SceneGenerationBudget {
  const usage = budget.usage
  return {
    ...execution.budget,
    modelCallsUsed: usage.modelAttempts,
    toolCallsUsed: usage.toolCalls,
    activeElapsedMs: usage.activeMs,
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    totalTokens: usage.tokens,
    tokenLimit: budget.limits.tokens ?? execution.budget.tokenLimit ?? null
  }
}

/**
 * 用唯一一次完整完成记录结束本步候选写入，题组随记录保存。
 * 保存失败不保留 started；抛给工作流统一结算。
 * @throws {AppException} 完成记录未保存。
 */
export async function finishCandidateEffect(
  stateRoot: string,
  execution: SceneGenerationExecution,
  stepId: string,
  inputDigest: string,
  revision: { candidateSnapshotId: string },
  questions: readonly DurableEffectQuestion[]
): Promise<void> {
  try {
    await writeDurableEffect(stateRoot, execution, {
      operationId: execution.operationId,
      stepId,
      inputDigest,
      status: 'completed',
      kind: 'fileWrite',
      candidateRevision: revision.candidateSnapshotId,
      resultDigest: revision.candidateSnapshotId,
      questions
    })
  } catch (error) {
    throw new AppException({
      code: ErrorCodes.internalError,
      msg: '候选完成记录未保存',
      cause: error
    })
  }
}
