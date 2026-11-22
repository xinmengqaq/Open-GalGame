import type { SceneGenerationProductionContext } from '@application/scene-generation/ports/SceneGenerationProductionContext'
import type { SceneSourceLocation } from '@application/scenes/models/SceneSourceLocation'
import { RegisteredSceneLocationGatewayImpl } from '@infrastructure/scenes/RegisteredSceneLocationGatewayImpl'

export class RegisteredSceneProductionContext implements SceneGenerationProductionContext {
  private readonly locations: RegisteredSceneLocationGatewayImpl

  constructor(userDirectory: string) {
    this.locations = new RegisteredSceneLocationGatewayImpl(userDirectory)
  }

  resolveRegisteredScene(scene: {
    projectId: string
    sceneId: string
  }): Promise<SceneSourceLocation> {
    return this.locations.resolveRegisteredScene(scene)
  }
}
