import type { SceneSourceLocation } from '../../scenes/models/SceneSourceLocation'

export interface SceneGenerationProductionContext {
  resolveRegisteredScene(scene: {
    projectId: string
    sceneId: string
  }): Promise<SceneSourceLocation>
}
