import type {
  ForkSceneGenerationDTO,
  GenerateSceneDTO,
  ReplySceneGenerationInteractionDTO,
  RetrySceneGenerationRepairDTO,
  SceneGenerationScopeDTO
} from '../dto/SceneGenerationDTO'
import type {
  SceneGenerationForkResultVO,
  SceneGenerationOperationVO,
  SceneGenerationReplyReceiptVO,
  SceneGenerationStatusVO
} from '../vo/SceneGenerationVO'

export interface SceneGenerationApplicationService {
  generateScene(request: GenerateSceneDTO): Promise<SceneGenerationOperationVO>

  cancelSceneGeneration(request: SceneGenerationScopeDTO): Promise<SceneGenerationStatusVO>

  replySceneGenerationInteraction(
    request: ReplySceneGenerationInteractionDTO
  ): Promise<SceneGenerationReplyReceiptVO>

  resumeSceneGeneration(request: SceneGenerationScopeDTO): Promise<SceneGenerationStatusVO>

  forkSceneGeneration(request: ForkSceneGenerationDTO): Promise<SceneGenerationForkResultVO>

  retryFailedRepair(
    request: RetrySceneGenerationRepairDTO & { operationId: string }
  ): Promise<SceneGenerationOperationVO>
}
