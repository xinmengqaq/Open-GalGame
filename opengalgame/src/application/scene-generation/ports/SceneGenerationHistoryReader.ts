import type {
  ListSceneGenerationHistoryDTO,
  ReadSceneGenerationCheckpointDTO
} from '../dto/SceneGenerationDTO'
import type { SceneGenerationCheckpoint } from '../models/SceneGenerationExecution'
import type { SceneGenerationHistoryVO } from '../vo/SceneGenerationVO'

export interface SceneGenerationHistoryReader {
  listHistory(request: ListSceneGenerationHistoryDTO): Promise<SceneGenerationHistoryVO>

  readCheckpoint(request: ReadSceneGenerationCheckpointDTO): Promise<SceneGenerationCheckpoint>
}
