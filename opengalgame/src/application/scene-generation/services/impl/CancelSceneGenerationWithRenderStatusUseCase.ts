import type { SceneGenerationScopeDTO } from '../../dto/SceneGenerationDTO'
import type { SceneGenerationStatusVO } from '../../vo/SceneGenerationVO'
import type { SceneGenerationRenderStatusVO } from '../../vo/SceneGenerationRenderVO'
import { toRenderStatusVO } from '../../mapping/SceneGenerationRenderProjection'
import { operationKey } from '../../policies/SceneGenerationIdempotency'
import type { SceneGenerationServiceContext } from './SceneGenerationServiceContext'

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
    return toRenderStatusVO(
      await this.context.coordinator.requireExecution(request),
      false,
      this.context.deps.workflow.capabilities(),
      this.context.coordinator.activeExecutions.has(operationKey(request))
    )
  }
}
