import type { SceneGenerationProductionContext } from '@application/scene-generation/ports/SceneGenerationProductionContext'
import type { SceneSourceLocation } from '@application/scenes/models/SceneSourceLocation'
import { RegisteredSceneLocationGatewayImpl } from '@infrastructure/scenes/RegisteredSceneLocationGatewayImpl'

/**
 * 从本机已登记工程和已保存场景画布解析生成位置。
 * 不读取静态测试登记，也不把唯一脚本猜测成已登记场景。
 */
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
