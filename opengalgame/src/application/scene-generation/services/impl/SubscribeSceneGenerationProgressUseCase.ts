import type { SceneGenerationScopeDTO } from '../../dto/SceneGenerationDTO'
import type { SceneGenerationRenderProgressEventVO } from '../../vo/SceneGenerationRenderVO'
import type { Unsubscribe } from '../SceneGenerationRenderQueryService'
import type { SceneGenerationServiceContext } from './SceneGenerationServiceContext'

export class SubscribeSceneGenerationProgressUseCase {
  constructor(private readonly context: SceneGenerationServiceContext) {}

  subscribeSceneGenerationProgress(
    request: SceneGenerationScopeDTO,
    publish: (event: SceneGenerationRenderProgressEventVO) => void
  ): Unsubscribe {
    return this.context.coordinator.subscribeRenderProgress(request, publish)
  }
}
