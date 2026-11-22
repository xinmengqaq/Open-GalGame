import type { SceneGenerationThreadDTO } from '../dto/SceneGenerationDTO'
import type { ClearSceneGenerationMemoryVO } from '../vo/SceneGenerationVO'

export interface SceneGenerationMemoryService {
  clearSceneGenerationMemory(
    request: SceneGenerationThreadDTO
  ): Promise<ClearSceneGenerationMemoryVO>
}
