import type { SceneGenerationScopeDTO } from '../../dto/SceneGenerationDTO'
import type { SceneGenerationStatusVO } from '../../vo/SceneGenerationVO'
import type { SceneGenerationRenderStatusVO } from '../../vo/SceneGenerationRenderVO'
import { toRenderStatusVO } from '../../mapping/SceneGenerationRenderProjection'
import type { SceneGenerationServiceContext } from './SceneGenerationServiceContext'

/** 控制端口可调用的取消费力；由应用服务实现。 */
interface SceneGenerationCancelGateway {
  cancelSceneGeneration(request: SceneGenerationScopeDTO): Promise<SceneGenerationStatusVO>
}

export class CancelSceneGenerationWithRenderStatusUseCase {
  constructor(
    private readonly context: SceneGenerationServiceContext,
    private readonly generation: SceneGenerationCancelGateway,
  ) {}

  async cancelSceneGeneration(
    request: SceneGenerationScopeDTO
  ): Promise<SceneGenerationRenderStatusVO> {
    await this.generation.cancelSceneGeneration(request)
    return toRenderStatusVO(await this.context.coordinator.requireExecution(request))
  }
}
