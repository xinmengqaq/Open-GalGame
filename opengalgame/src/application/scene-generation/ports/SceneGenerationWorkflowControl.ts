import type { SceneGenerationExecution } from '../models/SceneGenerationExecution'

export interface SceneGenerationWorkflowControl {
  requestPauseAtSafeCheckpoint(execution: SceneGenerationExecution): Promise<void>
  /**
   * 提交已完成后丢弃可提交结果留下的暂停边界。
   * 只清理当前操作的边界，不改变执行记录或候选修订。
   */
  clearPauseBoundary(execution: SceneGenerationExecution): Promise<void>
}
