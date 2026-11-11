import type { SceneGenerationScopeDTO } from '../dto/SceneGenerationDTO'
import type { SceneGenerationStatusVO } from '../vo/SceneGenerationVO'

export interface SceneGenerationStatusQueryService {
  /**
   * 只读查询持久状态与待回复问题，不自动恢复或修复。
   * @throws {AppException} 操作不存在或身份不匹配。
   */
  getSceneGenerationStatus(request: SceneGenerationScopeDTO): Promise<SceneGenerationStatusVO>
}
