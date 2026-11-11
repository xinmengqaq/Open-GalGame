import type { ReadScenePreviewAvailabilityDTO } from '../dto/ScenePreviewAvailabilityDTO'
import type {
  PreviewDialogueDraftDTO,
  ReadDialogueSaveSettlementDTO,
  SaveDialogueChangesDTO
} from '../dto/DialogueSaveDTO'
import type {
  PreviewDialoguePlaybackDTO,
  PreviewSessionRef,
  PreviewSubscriptionRequest
} from '../dto/PreviewPlaybackDTO'
import type { OpenScenePreviewDTO, PreparePreviewStageDTO } from '../dto/ScenePreviewSessionDTO'
import type { DialogueSaveSettlementVO, SaveDialogueChangesVO } from '../vo/DialogueSaveVO'
import type {
  PreviewCommandResultVO,
  PreviewDraftResultVO,
  PreviewRuntimeListener,
  PreviewStageResultVO
} from '../vo/PreviewRuntimeVO'
import type { ScenePreviewAvailabilityVO } from '../vo/ScenePreviewAvailabilityVO'
import type { ScenePreviewSessionVO } from '../vo/ScenePreviewSessionVO'

export interface ScenePreviewApplicationService {
  readScenePreviewAvailability(
    request: ReadScenePreviewAvailabilityDTO
  ): Promise<ScenePreviewAvailabilityVO>

  openScenePreview(request: OpenScenePreviewDTO): Promise<ScenePreviewSessionVO>

  preparePreviewStage(request: PreparePreviewStageDTO): Promise<PreviewStageResultVO>

  previewDialogueDraft(request: PreviewDialogueDraftDTO): Promise<PreviewDraftResultVO>

  saveDialogueChanges(request: SaveDialogueChangesDTO): Promise<SaveDialogueChangesVO>

  readDialogueSaveSettlement(
    request: ReadDialogueSaveSettlementDTO
  ): Promise<DialogueSaveSettlementVO>

  selectPreviewDialogue(request: PreviewDialoguePlaybackDTO): Promise<PreviewCommandResultVO>

  playPreviousDialogue(request: PreviewDialoguePlaybackDTO): Promise<PreviewCommandResultVO>

  playNextDialogue(request: PreviewDialoguePlaybackDTO): Promise<PreviewCommandResultVO>

  subscribePreviewRuntime(
    request: PreviewSubscriptionRequest,
    listener: PreviewRuntimeListener
  ): () => void

  closeScenePreview(request: PreviewSessionRef): Promise<void>
}
