import type {
  RetrySceneGenerationRepairDTO,
  StartSceneGenerationDTO
} from '../../dto/SceneGenerationDTO'
import type { SceneGenerationRenderStatusVO } from '../../vo/SceneGenerationRenderVO'
import type { SceneGenerationApplicationService } from '../SceneGenerationApplicationService'
import type { SceneGenerationLaunchService } from '../SceneGenerationLaunchService'
import { RetrySceneGenerationRepairUseCase } from './RetrySceneGenerationRepairUseCase'
import { StartSceneGenerationUseCase } from './StartSceneGenerationUseCase'
import type {
  SceneGenerationCoordinator,
  SceneGenerationDependencies
} from './SceneGenerationCoordinator'
import type { SceneGenerationRenderDependencies } from './SceneGenerationRenderDependencies'
import type { SceneGenerationServiceContext } from './SceneGenerationServiceContext'

export class SceneGenerationLaunchServiceImpl implements SceneGenerationLaunchService {
  private readonly start: StartSceneGenerationUseCase
  private readonly retryRepair: RetrySceneGenerationRepairUseCase

  constructor(
    deps: SceneGenerationDependencies,
    renderDeps: SceneGenerationRenderDependencies,
    generation: SceneGenerationApplicationService,
    coordinator: SceneGenerationCoordinator
  ) {
    const context: SceneGenerationServiceContext = { deps, coordinator }
    this.start = new StartSceneGenerationUseCase(context, renderDeps, generation)
    this.retryRepair = new RetrySceneGenerationRepairUseCase(context, renderDeps, generation)
  }

  async startSceneGeneration(
    request: StartSceneGenerationDTO
  ): Promise<SceneGenerationRenderStatusVO> {
    return this.start.startSceneGeneration(request)
  }

  async retrySceneGenerationRepair(
    request: RetrySceneGenerationRepairDTO
  ): Promise<SceneGenerationRenderStatusVO> {
    return this.retryRepair.retrySceneGenerationRepair(request)
  }
}
