import type { SceneGenerationRenderStatusVO } from '../../vo/SceneGenerationRenderVO'
import { toRenderStatusVO } from '../../mapping/SceneGenerationRenderProjection'
import { checkpointCanContinue } from './SceneGenerationCoordinator'
import { operationKey } from '../../policies/SceneGenerationIdempotency'
import type { SceneGenerationServiceContext } from './SceneGenerationServiceContext'

export class GetLatestSceneGenerationUseCase {
  constructor(private readonly context: SceneGenerationServiceContext) {}

  async findLatestSceneGeneration(request: {
    projectId: string
    sceneId: string
  }): Promise<SceneGenerationRenderStatusVO | null> {
    const execution = await this.context.deps.executions.findLatestSceneExecution(
      request.projectId,
      request.sceneId
    )
    if (!execution) return null
    return toRenderStatusVO(
      execution,
      await checkpointCanContinue(this.context.deps, execution),
      this.context.deps.workflow.capabilities(),
      this.context.coordinator.activeExecutions.has(operationKey(execution))
    )
  }
}
