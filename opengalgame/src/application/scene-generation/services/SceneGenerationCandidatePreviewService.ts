import type {
  CloseSceneGenerationCandidatePreviewDTO,
  OpenSceneGenerationCandidatePreviewDTO
} from '../dto/SceneGenerationDTO'

import type { SceneGenerationCandidatePreviewVO } from '../vo/SceneGenerationRenderVO'

export interface SceneGenerationCandidatePreviewService {
  openSceneGenerationCandidatePreview(
    request: OpenSceneGenerationCandidatePreviewDTO
  ): Promise<SceneGenerationCandidatePreviewVO>

  closeSceneGenerationCandidatePreview(
    request: CloseSceneGenerationCandidatePreviewDTO
  ): Promise<void>
}
