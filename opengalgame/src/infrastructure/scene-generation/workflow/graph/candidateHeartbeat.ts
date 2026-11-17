import type {
  SceneGenerationExecution,
  SceneGenerationRuntime
} from '@application/scene-generation/models/SceneGenerationExecution'
import type { ExecutionBudget } from '@infrastructure/ai/execution/ExecutionBudget'
import { budgetSnapshot } from './settlement'

const CANDIDATE_HEARTBEAT_INTERVAL_MS = 1500

/** 首次立即发布生成进度，之后每 1500ms 补发；同一时刻只保留一个发布，返回清理函数。 */
export function startCandidateHeartbeat(input: {
  runtime: Pick<SceneGenerationRuntime, 'publishProgress'>
  execution: SceneGenerationExecution
  budget: ExecutionBudget
}): () => void {
  let publishing = false
  const publishGenerating = (): void => {
    if (publishing) return
    publishing = true
    void input.runtime
      .publishProgress({
        step: 'generating',
        attempt: input.execution.attempt,
        budget: budgetSnapshot(input.execution, input.budget)
      })
      .then(
        () => {
          publishing = false
        },
        () => {
          publishing = false
        }
      )
  }
  publishGenerating()
  const heartbeat = setInterval(publishGenerating, CANDIDATE_HEARTBEAT_INTERVAL_MS)
  return () => clearInterval(heartbeat)
}
