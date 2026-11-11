import type { ForkSceneGenerationDTO } from '../dto/SceneGenerationDTO'
import type {
  SceneGenerationRuntime,
  SceneGenerationWorkflowOutcome
} from '../models/SceneGenerationExecution'

export interface SceneGenerationWorkflow {
  /**
   * 沿用分支记忆生成真实文件，编排有限修正、领域判断及可选人工等待。
   * @param runtime - 执行快照、取消信号及必须等待的进度持久化回调。
   * @returns 通过工作流检查的候选、人工等待或可恢复中断；不提交正式作品。
   * @throws {AppException} 模型、工具、读取或工作流失败；取消信号须实际传递。
   */
  executeGeneration(runtime: SceneGenerationRuntime): Promise<SceneGenerationWorkflowOutcome>

  /**
   * 核对检查点格式、输入与副作用结果后继续原操作，不重置预算或重放已完成副作用。
   * @throws {AppException} 恢复依据缺失、不兼容或副作用结果无法确认。
   */
  resumeGeneration(runtime: SceneGenerationRuntime): Promise<SceneGenerationWorkflowOutcome>

  /**
   * 使用已持久接受的 pendingReply 继续同一操作，去重消息并重新校验修改后的文件。
   * @returns 候选、下一次等待或中断，不以人工接受代替领域校验。
   * @throws {AppException} 恢复失败；同一回复可据持久记录重试。
   */
  continueInteraction(runtime: SceneGenerationRuntime): Promise<SceneGenerationWorkflowOutcome>

  /**
   * 从完整且兼容的已完成任务边界分叉，重建等待与任务身份并失效受修改影响的旧结论。
   * @returns 新分支候选、等待或中断，不重放正式提交或覆盖原分支。
   * @throws {AppException} 历史不可继续或分叉执行失败。
   */
  forkGeneration(
    runtime: SceneGenerationRuntime,
    request: ForkSceneGenerationDTO
  ): Promise<SceneGenerationWorkflowOutcome>
}
