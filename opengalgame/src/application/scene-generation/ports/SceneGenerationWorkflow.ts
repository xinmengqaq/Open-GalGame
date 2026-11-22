import type { ForkSceneGenerationDTO } from '../dto/SceneGenerationDTO'
import type {
  SceneGenerationExecution,
  SceneGenerationRuntime,
  SceneGenerationWorkflowOutcome
} from '../models/SceneGenerationExecution'

/**
 * 当前执行器实际具备的继续能力。
 * 应用在展示动作、写入回复或创建恢复操作前必须据此收窄；缺失即视为不支持。
 */
export interface SceneGenerationWorkflowCapabilities {
  /** 能否从检查点继续未完成执行。 */
  readonly resume: boolean
  /** 能否请求安全暂停并保留可继续的检查点。 */
  readonly pause: boolean
  /** 能否处理审阅/补充等人工回复并继续同一操作。 */
  readonly continueInteraction: boolean
  /** 能否从历史检查点创建新分支。 */
  readonly fork: boolean
}

export interface SceneGenerationWorkflow {
  /**
   * 当前实现实际具备的继续能力。展示和持久化前先查询，不把未实现能力当成可用。
   */
  capabilities(): SceneGenerationWorkflowCapabilities

  /**
   * 失败、取消或中断终结时使用的只读操作边界标识。
   * 应用不解释其格式，只保证历史仍能按原操作身份找到该边界。
   */
  checkpointIdFor(execution: SceneGenerationExecution): string

  executeGeneration(runtime: SceneGenerationRuntime): Promise<SceneGenerationWorkflowOutcome>

  resumeGeneration(runtime: SceneGenerationRuntime): Promise<SceneGenerationWorkflowOutcome>

  continueInteraction(runtime: SceneGenerationRuntime): Promise<SceneGenerationWorkflowOutcome>

  forkGeneration(
    runtime: SceneGenerationRuntime,
    request: ForkSceneGenerationDTO
  ): Promise<SceneGenerationWorkflowOutcome>
}
