import type {
  ListUnfinishedSceneGenerationsDTO,
  SceneGenerationScopeDTO
} from '../../dto/SceneGenerationDTO'
import type {
  SceneGenerationRenderProgressEventVO,
  SceneGenerationRenderStatusVO,
  SceneGenerationTimelineEntryVO,
  SceneGenerationUnfinishedPageVO
} from '../../vo/SceneGenerationRenderVO'
import type {
  SceneGenerationRenderQueryService,
  Unsubscribe
} from '../SceneGenerationRenderQueryService'
import { GetLatestSceneGenerationUseCase } from './GetLatestSceneGenerationUseCase'
import { GetSceneGenerationRenderStatusUseCase } from './GetSceneGenerationRenderStatusUseCase'
import { ListUnfinishedSceneGenerationsUseCase } from './ListUnfinishedSceneGenerationsUseCase'
import { ListSceneGenerationTimelineUseCase } from './ListSceneGenerationTimelineUseCase'
import { SubscribeSceneGenerationProgressUseCase } from './SubscribeSceneGenerationProgressUseCase'
import type {
  SceneGenerationCoordinator,
  SceneGenerationDependencies
} from './SceneGenerationCoordinator'
import type { SceneGenerationServiceContext } from './SceneGenerationServiceContext'

export class QuerySceneGenerationRender implements SceneGenerationRenderQueryService {
  private readonly renderStatus: GetSceneGenerationRenderStatusUseCase
  private readonly progress: SubscribeSceneGenerationProgressUseCase
  private readonly timeline: ListSceneGenerationTimelineUseCase
  private readonly latest: GetLatestSceneGenerationUseCase
  private readonly unfinished: ListUnfinishedSceneGenerationsUseCase

  constructor(deps: SceneGenerationDependencies, coordinator: SceneGenerationCoordinator) {
    const context: SceneGenerationServiceContext = { deps, coordinator }
    this.renderStatus = new GetSceneGenerationRenderStatusUseCase(context)
    this.progress = new SubscribeSceneGenerationProgressUseCase(context)
    this.timeline = new ListSceneGenerationTimelineUseCase(context)
    this.latest = new GetLatestSceneGenerationUseCase(context)
    this.unfinished = new ListUnfinishedSceneGenerationsUseCase(context)
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

  async listUnfinishedSceneGenerations(
    request: ListUnfinishedSceneGenerationsDTO
  ): Promise<SceneGenerationUnfinishedPageVO> {
    return this.unfinished.listUnfinishedSceneGenerations(request)
  }
}
