import type {
  SceneGenerationBudget,
  SceneGenerationExecution
} from '@application/scene-generation/models/SceneGenerationExecution'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { ExecutionBudget } from '@infrastructure/ai/execution/ExecutionBudget'
import type { DurableEffectQuestion } from '@infrastructure/workflow/DurableEffectRecord'
import { writeDurableEffect } from '@infrastructure/workflow/execution/durableEffect'

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
