import type { SceneGenerationScopeDTO } from '../dto/SceneGenerationDTO'
import type { SceneGenerationStatusVO } from '../vo/SceneGenerationVO'

export interface SceneGenerationStatusQueryService {
  getSceneGenerationStatus(request: SceneGenerationScopeDTO): Promise<SceneGenerationStatusVO>
}
