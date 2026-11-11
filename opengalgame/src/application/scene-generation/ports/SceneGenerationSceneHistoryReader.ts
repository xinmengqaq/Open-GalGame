import type { ListSceneGenerationHistoryForSceneDTO } from '../dto/SceneGenerationDTO'
import type { SceneGenerationExecution } from '../models/SceneGenerationExecution'

/**
 * 按场景读取已持久化的生成操作。
 * 不扫描其他工程，也不把线程检查点全部当成 AI 历史。
 */
export interface SceneGenerationSceneHistoryReader {
  /**
   * @returns 当前场景已保存的操作，按持久顺序返回。
   * @throws {AppException} 身份越界或读取失败。
   */
  listSceneExecutions(
    request: ListSceneGenerationHistoryForSceneDTO
  ): Promise<readonly SceneGenerationExecution[]>
}
