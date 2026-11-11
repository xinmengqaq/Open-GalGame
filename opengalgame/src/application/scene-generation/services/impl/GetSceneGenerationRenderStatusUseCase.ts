import type { SceneGenerationScopeDTO } from '../../dto/SceneGenerationDTO'
import type { SceneGenerationRenderStatusVO } from '../../vo/SceneGenerationRenderVO'
import { toRenderStatusVO } from '../../mapping/SceneGenerationRenderProjection'
import { checkpointCanContinue } from './SceneGenerationCoordinator'
import type { SceneGenerationServiceContext } from './SceneGenerationServiceContext'

export class GetSceneGenerationRenderStatusUseCase {
  constructor(private readonly context: SceneGenerationServiceContext) {}

  async getSceneGenerationRenderStatus(
    request: SceneGenerationScopeDTO
  ): Promise<SceneGenerationRenderStatusVO> {
    const execution = await this.context.coordinator.requireExecution(request)
    return toRenderStatusVO(execution, await checkpointCanContinue(this.context.deps, execution))
  }
}
