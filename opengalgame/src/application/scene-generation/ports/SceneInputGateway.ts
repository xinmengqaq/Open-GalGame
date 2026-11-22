import type { SceneGenerationInputsDTO, SceneInputSelectionDTO } from '../dto/SceneGenerationDTO'
import type { SceneSourceLocation } from '../../scenes/models/SceneSourceLocation'

export interface SceneInputGateway {
  locateScene(scene: { projectId: string; sceneId: string }): Promise<SceneSourceLocation>

  readInputs(
    source: SceneSourceLocation,
    selection: SceneInputSelectionDTO
  ): Promise<SceneGenerationInputsDTO>
}
