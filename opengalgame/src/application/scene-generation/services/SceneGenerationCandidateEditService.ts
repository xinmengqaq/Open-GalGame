import type { EditSceneGenerationCandidateDTO } from '../dto/SceneGenerationDTO'
import type { SceneGenerationStatusVO } from '../vo/SceneGenerationVO'

export interface SceneGenerationCandidateEditService {
  editSceneGenerationCandidate(
    request: EditSceneGenerationCandidateDTO
  ): Promise<SceneGenerationStatusVO>
}
