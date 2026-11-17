import type { SceneGenerationExecution } from '@application/scene-generation/models/SceneGenerationExecution'
import type { ExecutionBudget } from '@infrastructure/ai/execution/ExecutionBudget'

/**
 * 把本次工作流的实际用量写回运行预算，保留操作级修正次数和已有 token 上限。
 */
export function persistedBudget(
  previous: SceneGenerationExecution['budget'],
  budget: ExecutionBudget
): SceneGenerationExecution['budget'] {
  const usage = budget.usage
  return {
    ...previous,
    modelCallsUsed: usage.modelAttempts,
    toolCallsUsed: usage.toolCalls,
    activeElapsedMs: usage.activeMs,
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    totalTokens: usage.tokens,
    tokenLimit: budget.limits.tokens ?? previous.tokenLimit ?? null
  }
}
