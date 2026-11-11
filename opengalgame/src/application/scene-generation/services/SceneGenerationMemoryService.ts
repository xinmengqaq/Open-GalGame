import type { SceneGenerationThreadDTO } from '../dto/SceneGenerationDTO'
import type { ClearSceneGenerationMemoryVO } from '../vo/SceneGenerationVO'

export interface SceneGenerationMemoryService {
  /**
   * 清理没有活动操作的线程记忆及关联历史内容，不修改正式作品。
   * @throws {AppException} 线程尚有运行、等待或待恢复操作，或清理失败。
   */
  clearSceneGenerationMemory(
    request: SceneGenerationThreadDTO
  ): Promise<ClearSceneGenerationMemoryVO>
}
