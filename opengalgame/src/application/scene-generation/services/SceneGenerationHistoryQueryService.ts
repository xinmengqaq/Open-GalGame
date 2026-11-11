import type {
  ListSceneGenerationHistoryDTO,
  ListSceneGenerationHistoryForSceneDTO,
  ReadSceneGenerationCheckpointDTO
} from '../dto/SceneGenerationDTO'
import type { SceneGenerationCheckpointVO, SceneGenerationHistoryVO } from '../vo/SceneGenerationVO'
import type { SceneGenerationHistorySummaryVO } from '../vo/SceneGenerationRenderVO'

export interface SceneGenerationHistoryQueryService {
  /**
   * 分页查询安全历史摘要，不执行模型或工具。
   * @throws {AppException} 身份越界或历史读取失败。
   */
  listSceneGenerationHistory(
    request: ListSceneGenerationHistoryDTO
  ): Promise<SceneGenerationHistoryVO>

  /**
   * 读取安全历史详情，不向调用方暴露内部恢复种子。
   * @throws {AppException} 历史不存在或身份越界。
   */
  readSceneGenerationCheckpoint(
    request: ReadSceneGenerationCheckpointDTO
  ): Promise<SceneGenerationCheckpointVO>

  /**
   * 按当前场景聚合有意义的 AI 操作边界，最新记录在前，并以末条检查点向更早分页。
   * 不合并作品版本历史，不执行模型或工具。
   * @throws {AppException} 页大小或游标无效，或历史读取失败。
   */
  listSceneGenerationHistoryForScene(
    request: ListSceneGenerationHistoryForSceneDTO
  ): Promise<readonly SceneGenerationHistorySummaryVO[]>
}
