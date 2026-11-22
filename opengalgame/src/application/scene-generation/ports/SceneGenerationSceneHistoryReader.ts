import type { ListSceneGenerationHistoryForSceneDTO } from '../dto/SceneGenerationDTO'
import type { SceneGenerationExecution } from '../models/SceneGenerationExecution'

export interface SceneGenerationSceneHistoryReader {
  listSceneExecutions(
    request: ListSceneGenerationHistoryForSceneDTO
  ): Promise<readonly SceneGenerationExecution[]>
}
