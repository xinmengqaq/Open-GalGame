import type { SceneGenerationScopeDTO } from '../../dto/SceneGenerationDTO'
import type { SceneGenerationTimelineEntryVO } from '../../vo/SceneGenerationRenderVO'
import { toTimeline } from '../../mapping/SceneGenerationRenderProjection'
import type { SceneGenerationServiceContext } from './SceneGenerationServiceContext'

export class ListSceneGenerationTimelineUseCase {
  constructor(private readonly context: SceneGenerationServiceContext) {}

  async listSceneGenerationTimeline(
    request: SceneGenerationScopeDTO
  ): Promise<readonly SceneGenerationTimelineEntryVO[]> {
    return toTimeline(await this.context.coordinator.requireExecution(request))
  }
}
