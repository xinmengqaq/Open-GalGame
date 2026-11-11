import type {
  CloseSceneGenerationCandidatePreviewDTO,
  OpenSceneGenerationCandidatePreviewDTO
} from '../../dto/SceneGenerationDTO'
import type { SceneGenerationCandidatePreviewVO } from '../../vo/SceneGenerationRenderVO'
import type { SceneGenerationCandidatePreviewService } from '../SceneGenerationCandidatePreviewService'
import { CloseSceneGenerationCandidatePreviewUseCase } from './CloseSceneGenerationCandidatePreviewUseCase'
import { OpenSceneGenerationCandidatePreviewUseCase } from './OpenSceneGenerationCandidatePreviewUseCase'
import type {
  SceneGenerationCoordinator,
  SceneGenerationDependencies
} from './SceneGenerationCoordinator'
import type { SceneGenerationRenderDependencies } from './SceneGenerationRenderDependencies'
import type { SceneGenerationServiceContext } from './SceneGenerationServiceContext'

export class SceneGenerationCandidatePreviewServiceImpl implements SceneGenerationCandidatePreviewService {
  private readonly openUseCase: OpenSceneGenerationCandidatePreviewUseCase
  private readonly closeUseCase: CloseSceneGenerationCandidatePreviewUseCase

  constructor(
    deps: SceneGenerationDependencies,
    renderDeps: SceneGenerationRenderDependencies,
    coordinator: SceneGenerationCoordinator
  ) {
    const context: SceneGenerationServiceContext = { deps, coordinator }
    this.openUseCase = new OpenSceneGenerationCandidatePreviewUseCase(context, renderDeps)
    this.closeUseCase = new CloseSceneGenerationCandidatePreviewUseCase(context, renderDeps)
  }

  async openSceneGenerationCandidatePreview(
    request: OpenSceneGenerationCandidatePreviewDTO
  ): Promise<SceneGenerationCandidatePreviewVO> {
    return this.openUseCase.openSceneGenerationCandidatePreview(request)
  }

  async closeSceneGenerationCandidatePreview(
    request: CloseSceneGenerationCandidatePreviewDTO
  ): Promise<void> {
    return this.closeUseCase.closeSceneGenerationCandidatePreview(request)
  }
}
