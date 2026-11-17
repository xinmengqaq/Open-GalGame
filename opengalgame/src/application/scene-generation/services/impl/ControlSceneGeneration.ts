import type {
  ResumeSceneGenerationDTO,
  SceneGenerationScopeDTO
} from '../../dto/SceneGenerationDTO'
import type { SceneGenerationRenderStatusVO } from '../../vo/SceneGenerationRenderVO'
import type { SceneGenerationApplicationService } from '../SceneGenerationApplicationService'
import type { SceneGenerationControlService } from '../SceneGenerationControlService'
import { CancelSceneGenerationWithRenderStatusUseCase } from './CancelSceneGenerationWithRenderStatusUseCase'
import { PauseSceneGenerationUseCase } from './PauseSceneGenerationUseCase'
import {
  ResumeSceneGenerationFromCheckpointUseCase,
  type SceneGenerationResumeGateway
} from './ResumeSceneGenerationFromCheckpointUseCase'
import type {
  SceneGenerationCoordinator,
  SceneGenerationDependencies
} from './SceneGenerationCoordinator'
import type { SceneGenerationServiceContext } from './SceneGenerationServiceContext'

export class ControlSceneGeneration implements SceneGenerationControlService {
  private readonly pause: PauseSceneGenerationUseCase
  private readonly resume: ResumeSceneGenerationFromCheckpointUseCase
  private readonly cancel: CancelSceneGenerationWithRenderStatusUseCase

  constructor(
    deps: SceneGenerationDependencies,
    coordinator: SceneGenerationCoordinator,
    generation: SceneGenerationApplicationService & SceneGenerationResumeGateway
  ) {
    const context: SceneGenerationServiceContext = { deps, coordinator }
    this.pause = new PauseSceneGenerationUseCase(context)
    this.resume = new ResumeSceneGenerationFromCheckpointUseCase(context, generation)
    this.cancel = new CancelSceneGenerationWithRenderStatusUseCase(context, generation)
  }

  async pauseSceneGeneration(
    request: SceneGenerationScopeDTO
  ): Promise<SceneGenerationRenderStatusVO> {
    return this.pause.pauseSceneGeneration(request)
  }

  async resumeSceneGeneration(
    request: ResumeSceneGenerationDTO
  ): Promise<SceneGenerationRenderStatusVO> {
    return this.resume.resumeSceneGeneration(request)
  }

  async cancelSceneGeneration(
    request: SceneGenerationScopeDTO
  ): Promise<SceneGenerationRenderStatusVO> {
    return this.cancel.cancelSceneGeneration(request)
  }
}
