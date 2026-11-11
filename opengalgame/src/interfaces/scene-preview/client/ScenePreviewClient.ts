import type {
  PreviewDialogueDraftDTO,
  ReadDialogueSaveSettlementDTO,
  SaveDialogueChangesDTO
} from '@application/scene-preview/dto/DialogueSaveDTO'
import type {
  PreviewDialoguePlaybackDTO,
  PreviewSessionRef,
  PreviewSubscriptionRequest
} from '@application/scene-preview/dto/PreviewPlaybackDTO'
import type { ReadCandidatePreviewDTO } from '@application/scene-preview/dto/ReadCandidatePreviewDTO'
import type { ReadScenePreviewAvailabilityDTO } from '@application/scene-preview/dto/ScenePreviewAvailabilityDTO'
import type {
  OpenScenePreviewDTO,
  PreparePreviewStageDTO
} from '@application/scene-preview/dto/ScenePreviewSessionDTO'
import type { CandidatePreviewVO } from '@application/scene-preview/vo/CandidatePreviewVO'
import type {
  DialogueSaveSettlementVO,
  SaveDialogueChangesVO
} from '@application/scene-preview/vo/DialogueSaveVO'
import type {
  PreviewCommandResultVO,
  PreviewDraftResultVO,
  PreviewRuntimeEventVO,
  PreviewStageResultVO
} from '@application/scene-preview/vo/PreviewRuntimeVO'
import type { ScenePreviewAvailabilityVO } from '@application/scene-preview/vo/ScenePreviewAvailabilityVO'
import type { ScenePreviewSessionVO } from '@application/scene-preview/vo/ScenePreviewSessionVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import type { CandidatePreviewEventVO } from '../contracts/ScenePreviewResponseSchema'

export interface ScenePreviewClient {
  readPreviewAvailability(
    request: ReadScenePreviewAvailabilityDTO
  ): Promise<AjaxResult<ScenePreviewAvailabilityVO>>
  openPreview(request: OpenScenePreviewDTO): Promise<AjaxResult<ScenePreviewSessionVO>>
  prepareStage(request: PreparePreviewStageDTO): Promise<AjaxResult<PreviewStageResultVO>>
  previewDialogueDraft(request: PreviewDialogueDraftDTO): Promise<AjaxResult<PreviewDraftResultVO>>
  saveDialogueChanges(request: SaveDialogueChangesDTO): Promise<AjaxResult<SaveDialogueChangesVO>>
  readDialogueSaveSettlement(
    request: ReadDialogueSaveSettlementDTO
  ): Promise<AjaxResult<DialogueSaveSettlementVO>>
  selectPreviewDialogue(
    request: PreviewDialoguePlaybackDTO
  ): Promise<AjaxResult<PreviewCommandResultVO>>
  playPreviousDialogue(
    request: PreviewDialoguePlaybackDTO
  ): Promise<AjaxResult<PreviewCommandResultVO>>
  playNextDialogue(request: PreviewDialoguePlaybackDTO): Promise<AjaxResult<PreviewCommandResultVO>>
  closePreview(request: PreviewSessionRef): Promise<AjaxResult<null>>
  /**
   * 先注册事件监听，再发送订阅请求。失败通过安全错误回调，不把事件当成功。
   * 旧会话、旧代次和旧序号在这里丢弃。
   */
  subscribeRuntime(
    scope: PreviewSubscriptionRequest,
    listener: (event: PreviewRuntimeEventVO) => void,
    onError?: (message: string) => void
  ): () => void
  readCandidatePreview(request: ReadCandidatePreviewDTO): Promise<AjaxResult<CandidatePreviewVO>>
  /**
   * 候选事件与正式运行时事件分开。身份不匹配时丢弃，退订后不再送达。
   */
  subscribeCandidatePreview(
    scope: ReadCandidatePreviewDTO,
    listener: (event: CandidatePreviewEventVO) => void
  ): () => void
}
