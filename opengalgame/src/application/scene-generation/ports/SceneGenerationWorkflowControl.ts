import type { SceneGenerationExecution } from '../models/SceneGenerationExecution'

/**
 * 工作流安全暂停回传。
 * 应用层只记录意图；基础设施在安全检查点消费，不能中途硬中断模型或候选写入。
 */
export interface SceneGenerationWorkflowControl {
  /**
   * 持久暂停意图已经写入后通知当前工作流。
   * 没有活动工作流时为空操作，恢复时仍以持久事实为准。
   */
  requestPauseAtSafeCheckpoint(execution: SceneGenerationExecution): Promise<void>
}
