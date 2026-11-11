import type { SceneGenerationScopeDTO } from '../../dto/SceneGenerationDTO'
import type {
  SceneGenerationRenderProgressEventVO,
  SceneGenerationRenderStatusVO,
  SceneGenerationTimelineEntryVO
} from '../../vo/SceneGenerationRenderVO'
import type {
  SceneGenerationRenderQueryService,
  Unsubscribe
} from '../SceneGenerationRenderQueryService'
import { GetLatestSceneGenerationUseCase } from './GetLatestSceneGenerationUseCase'
import { GetSceneGenerationRenderStatusUseCase } from './GetSceneGenerationRenderStatusUseCase'
import { ListSceneGenerationTimelineUseCase } from './ListSceneGenerationTimelineUseCase'
import { SubscribeSceneGenerationProgressUseCase } from './SubscribeSceneGenerationProgressUseCase'
import type {
  SceneGenerationCoordinator,
  SceneGenerationDependencies
} from './SceneGenerationCoordinator'
import type { SceneGenerationServiceContext } from './SceneGenerationServiceContext'

export class SceneGenerationRenderQueryServiceImpl implements SceneGenerationRenderQueryService {
  private readonly renderStatus: GetSceneGenerationRenderStatusUseCase
  private readonly progress: SubscribeSceneGenerationProgressUseCase
  private readonly timeline: ListSceneGenerationTimelineUseCase
  private readonly latest: GetLatestSceneGenerationUseCase

  constructor(deps: SceneGenerationDependencies, coordinator: SceneGenerationCoordinator) {
    const context: SceneGenerationServiceContext = { deps, coordinator }
    this.renderStatus = new GetSceneGenerationRenderStatusUseCase(context)
    this.progress = new SubscribeSceneGenerationProgressUseCase(context)
    this.timeline = new ListSceneGenerationTimelineUseCase(context)
    this.latest = new GetLatestSceneGenerationUseCase(context)
  }

  async getSceneGenerationRenderStatus(
    request: SceneGenerationScopeDTO
  ): Promise<SceneGenerationRenderStatusVO> {
    return this.renderStatus.getSceneGenerationRenderStatus(request)
  }

  subscribeSceneGenerationProgress(
    request: SceneGenerationScopeDTO,
    publish: (event: SceneGenerationRenderProgressEventVO) => void
  ): Unsubscribe {
    return this.progress.subscribeSceneGenerationProgress(request, publish)
  }

  async listSceneGenerationTimeline(
    request: SceneGenerationScopeDTO
  ): Promise<readonly SceneGenerationTimelineEntryVO[]> {
    return this.timeline.listSceneGenerationTimeline(request)
  }

  async findLatestSceneGeneration(request: {
    projectId: string
    sceneId: string
  }): Promise<SceneGenerationRenderStatusVO | null> {
    return this.latest.findLatestSceneGeneration(request)
  }
}
