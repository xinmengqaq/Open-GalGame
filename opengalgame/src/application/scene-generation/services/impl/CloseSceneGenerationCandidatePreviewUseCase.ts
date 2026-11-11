import type { CloseSceneGenerationCandidatePreviewDTO } from '../../dto/SceneGenerationDTO'
import type { SceneGenerationRenderDependencies } from './SceneGenerationRenderDependencies'
import type { SceneGenerationServiceContext } from './SceneGenerationServiceContext'

export class CloseSceneGenerationCandidatePreviewUseCase {
  constructor(
    private readonly context: SceneGenerationServiceContext,
    private readonly renderDeps: SceneGenerationRenderDependencies
  ) {}

  async closeSceneGenerationCandidatePreview(
    request: CloseSceneGenerationCandidatePreviewDTO
  ): Promise<void> {
    await this.context.coordinator.requireExecution(request)
    await this.renderDeps.preview.closeCandidatePreview(request)
  }
}
