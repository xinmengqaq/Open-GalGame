import type {
  ListSceneGenerationHistoryDTO,
  ListSceneGenerationHistoryForSceneDTO,
  ReadSceneGenerationCheckpointDTO
} from '../dto/SceneGenerationDTO'
import type { SceneGenerationCheckpointVO, SceneGenerationHistoryVO } from '../vo/SceneGenerationVO'
import type { SceneGenerationHistoryDetailVO, SceneGenerationHistorySummaryVO } from '../vo/SceneGenerationRenderVO'

export interface SceneGenerationHistoryQueryService {
  listSceneGenerationHistory(
    request: ListSceneGenerationHistoryDTO
  ): Promise<SceneGenerationHistoryVO>

  readSceneGenerationCheckpoint(
    request: ReadSceneGenerationCheckpointDTO
  ): Promise<SceneGenerationCheckpointVO>

  /**
   * 按需读取单条历史的展示摘要与分叉资格。资格由检查点、候选修订和副作用重新证明。
   * @throws {AppException} 历史不存在、身份越界或记录缺少可展示事实。
   */
  readSceneGenerationHistoryDetail(
    request: ReadSceneGenerationCheckpointDTO
  ): Promise<SceneGenerationHistoryDetailVO>

  listSceneGenerationHistoryForScene(
    request: ListSceneGenerationHistoryForSceneDTO
  ): Promise<readonly SceneGenerationHistorySummaryVO[]>
}
