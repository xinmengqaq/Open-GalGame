import type { SceneGenerationRenderStatusVO } from '../../vo/SceneGenerationRenderVO'
import { toRenderStatusVO } from '../../mapping/SceneGenerationRenderProjection'
import { checkpointCanContinue } from './SceneGenerationCoordinator'
import type { SceneGenerationServiceContext } from './SceneGenerationServiceContext'

/**
 * 当前场景最近一次操作的只读运行状态。运行中的操作可能还没有检查点，
 * 因此不能要求 checkpointId 才返回状态；没有执行记录时返回 null。
 */
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
    return toRenderStatusVO(execution, await checkpointCanContinue(this.context.deps, execution))
  }
}
