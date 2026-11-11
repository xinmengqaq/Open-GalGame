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
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { communicationFailureResult } from '../../client/communicationFailure'
import type { DesktopBridge } from '../../client/DesktopBridge'
import {
  parseCandidatePreviewEvent,
  parseCandidatePreviewEventResult,
  parseCandidatePreviewResult,
  parseDialogueSaveSettlementResult,
  parsePreviewCommandResult,
  parsePreviewDraftResult,
  parsePreviewRuntimeEvent,
  parsePreviewStageResult,
  parseSaveDialogueChangesResult,
  parseScenePreviewAvailabilityResult,
  parseScenePreviewNullResult,
  parseScenePreviewSessionResult,
  type CandidatePreviewEventVO
} from '../contracts/ScenePreviewResponseSchema'
import type { ScenePreviewClient } from './ScenePreviewClient'

const runtimeSubscriptionFailureMessage = '预览订阅未建立，请重新打开预览。'

async function readPreviewResult<T>(
  action: () => Promise<unknown>,
  parse: (value: unknown) => AjaxResult<T> | null
): Promise<AjaxResult<T>> {
  try {
    return parse(await action()) ?? communicationFailureResult()
  } catch {
    return communicationFailureResult()
  }
}

export class ScenePreviewClientImpl implements ScenePreviewClient {
  constructor(private readonly bridge: DesktopBridge) {}

  readPreviewAvailability(
    request: ReadScenePreviewAvailabilityDTO
  ): Promise<AjaxResult<ScenePreviewAvailabilityVO>> {
    return readPreviewResult(
      () => this.bridge.readScenePreviewAvailability(request),
      parseScenePreviewAvailabilityResult
    )
  }

  openPreview(request: OpenScenePreviewDTO): Promise<AjaxResult<ScenePreviewSessionVO>> {
    return readPreviewResult(
      () => this.bridge.openScenePreview(request),
      parseScenePreviewSessionResult
    )
  }

  prepareStage(request: PreparePreviewStageDTO): Promise<AjaxResult<PreviewStageResultVO>> {
    return readPreviewResult(
      () => this.bridge.preparePreviewStage(request),
      parsePreviewStageResult
    )
  }

  previewDialogueDraft(
    request: PreviewDialogueDraftDTO
  ): Promise<AjaxResult<PreviewDraftResultVO>> {
    return readPreviewResult(
      () => this.bridge.previewDialogueDraft(request),
      parsePreviewDraftResult
    )
  }

  saveDialogueChanges(request: SaveDialogueChangesDTO): Promise<AjaxResult<SaveDialogueChangesVO>> {
    return readPreviewResult(
      () => this.bridge.saveDialogueChanges(request),
      parseSaveDialogueChangesResult
    )
  }

  readDialogueSaveSettlement(
    request: ReadDialogueSaveSettlementDTO
  ): Promise<AjaxResult<DialogueSaveSettlementVO>> {
    return readPreviewResult(
      () => this.bridge.readDialogueSaveSettlement(request),
      parseDialogueSaveSettlementResult
    )
  }

  selectPreviewDialogue(
    request: PreviewDialoguePlaybackDTO
  ): Promise<AjaxResult<PreviewCommandResultVO>> {
    return readPreviewResult(
      () => this.bridge.selectPreviewDialogue(request),
      parsePreviewCommandResult
    )
  }

  playPreviousDialogue(
    request: PreviewDialoguePlaybackDTO
  ): Promise<AjaxResult<PreviewCommandResultVO>> {
    return readPreviewResult(
      () => this.bridge.playPreviousDialogue(request),
      parsePreviewCommandResult
    )
  }

  playNextDialogue(
    request: PreviewDialoguePlaybackDTO
  ): Promise<AjaxResult<PreviewCommandResultVO>> {
    return readPreviewResult(() => this.bridge.playNextDialogue(request), parsePreviewCommandResult)
  }

  closePreview(request: PreviewSessionRef): Promise<AjaxResult<null>> {
    return readPreviewResult(
      () => this.bridge.closeScenePreview(request),
      parseScenePreviewNullResult
    )
  }

  subscribeRuntime(
    scope: PreviewSubscriptionRequest,
    listener: (event: PreviewRuntimeEventVO) => void,
    onError?: (message: string) => void
  ): () => void {
    let active = true
    let lastGeneration = 0
    let lastSequence = 0
    const reportFailure = (): void => {
      if (active) onError?.(runtimeSubscriptionFailureMessage)
    }
    const stopListening = this.bridge.onScenePreviewRuntime((value) => {
      const event = parsePreviewRuntimeEvent(value)
      if (!active || !event || event.previewSessionId !== scope.previewSessionId) return
      if (event.runtimeGeneration < lastGeneration) return
      if (event.runtimeGeneration === lastGeneration && event.sequence <= lastSequence) return
      if (event.sequence <= 0) return
      lastGeneration = event.runtimeGeneration
      lastSequence = event.sequence
      listener(event)
    })
    try {
      void this.bridge
        .subscribeScenePreviewRuntime(scope)
        .then((result) => {
          if (result.code !== ErrorCodes.success) reportFailure()
        })
        .catch(reportFailure)
    } catch {
      reportFailure()
    }
    return () => {
      active = false
      stopListening()
    }
  }

  readCandidatePreview(request: ReadCandidatePreviewDTO): Promise<AjaxResult<CandidatePreviewVO>> {
    return readPreviewResult(
      () => this.bridge.readCandidatePreview(request),
      parseCandidatePreviewResult
    )
  }

  subscribeCandidatePreview(
    scope: ReadCandidatePreviewDTO,
    listener: (event: CandidatePreviewEventVO) => void
  ): () => void {
    let active = true
    let lastSequence = 0
    const receive = (value: unknown): void => {
      const event = parseCandidatePreviewEvent(value)
      if (
        !active ||
        !event ||
        event.projectId !== scope.projectId ||
        event.sceneId !== scope.sceneId ||
        event.previewSessionId !== scope.previewSessionId ||
        event.sequence <= lastSequence
      ) {
        return
      }
      lastSequence = event.sequence
      listener(event)
    }
    const stopReady = this.bridge.onCandidatePreviewReady(receive)
    const stopFailed = this.bridge.onCandidatePreviewStageFailed(receive)
    const stopInvalidated = this.bridge.onCandidatePreviewInvalidated(receive)
    void this.bridge
      .readCandidatePreviewEvent(scope)
      .then((result) => {
        if (!active) return
        const parsed = parseCandidatePreviewEventResult(result)
        if (parsed?.code === ErrorCodes.success && parsed.data) receive(parsed.data)
      })
      .catch(() => undefined)
    return () => {
      active = false
      stopReady()
      stopFailed()
      stopInvalidated()
    }
  }
}
