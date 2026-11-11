import type { SceneCandidatePreviewApplicationService } from '@application/scene-preview/services/SceneCandidatePreviewApplicationService'
import type { ScenePreviewApplicationService } from '@application/scene-preview/services/ScenePreviewApplicationService'
import type { SceneGenerationCandidatePreviewEventVO } from '@application/scene-generation/vo/SceneGenerationRenderVO'
import type { CandidatePreviewVO } from '@application/scene-preview/vo/CandidatePreviewVO'
import type {
  DialogueSaveSettlementVO,
  SaveDialogueChangesVO
} from '@application/scene-preview/vo/DialogueSaveVO'
import type {
  PreviewCommandResultVO,
  PreviewDraftResultVO,
  PreviewRuntimeListener,
  PreviewStageResultVO
} from '@application/scene-preview/vo/PreviewRuntimeVO'
import type { ScenePreviewAvailabilityVO } from '@application/scene-preview/vo/ScenePreviewAvailabilityVO'
import type { ScenePreviewSessionVO } from '@application/scene-preview/vo/ScenePreviewSessionVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import { ErrorCodes, errorMessages } from '@common/errors/ErrorCodes'
import { IpcExceptionHandler } from '../../ipc/errors/IpcExceptionHandler'
import { createRequestHandler, type IpcRequestHandler } from '../../ipc/requestHandler'
import type { IpcRequestAccess } from '../../ipc/RequestSchema'
import {
  openScenePreviewSchema,
  previewDialogueDraftSchema,
  previewDialoguePlaybackSchema,
  previewSessionSchema,
  subscribePreviewRuntimeSchema,
  readCandidatePreviewSchema,
  readDialogueSaveSettlementSchema,
  readScenePreviewAvailabilitySchema,
  saveDialogueChangesSchema
} from './ScenePreviewRequestSchema'

export class ScenePreviewController {
  private readonly handle: IpcRequestHandler

  constructor(
    private readonly currentScene: ScenePreviewApplicationService,
    private readonly candidatePreview: SceneCandidatePreviewApplicationService,
    exceptions: IpcExceptionHandler
  ) {
    this.handle = createRequestHandler(exceptions)
  }

  readAvailability(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<ScenePreviewAvailabilityVO>> {
    return this.handle(
      readScenePreviewAvailabilitySchema,
      input,
      access,
      '预览可用性已读取',
      (request) => this.currentScene.readScenePreviewAvailability(request)
    )
  }

  open(input: unknown, access: IpcRequestAccess): Promise<AjaxResult<ScenePreviewSessionVO>> {
    return this.handle(openScenePreviewSchema, input, access, '预览已打开', (request) =>
      this.currentScene.openScenePreview(request)
    )
  }

  prepare(input: unknown, access: IpcRequestAccess): Promise<AjaxResult<PreviewStageResultVO>> {
    return this.handle(previewSessionSchema, input, access, '舞台准备已返回', (request) =>
      this.currentScene.preparePreviewStage(request)
    )
  }

  previewDraft(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<PreviewDraftResultVO>> {
    return this.handle(previewDialogueDraftSchema, input, access, '草稿预览已返回', (request) =>
      this.currentScene.previewDialogueDraft(request)
    )
  }

  save(input: unknown, access: IpcRequestAccess): Promise<AjaxResult<SaveDialogueChangesVO>> {
    return this.handle(saveDialogueChangesSchema, input, access, '台词保存已返回', (request) =>
      this.currentScene.saveDialogueChanges(request)
    )
  }

  readSettlement(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<DialogueSaveSettlementVO>> {
    return this.handle(
      readDialogueSaveSettlementSchema,
      input,
      access,
      '保存结算已读取',
      (request) => this.currentScene.readDialogueSaveSettlement(request)
    )
  }

  selectDialogue(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<PreviewCommandResultVO>> {
    return this.handle(previewDialoguePlaybackSchema, input, access, '选句播放已返回', (request) =>
      this.currentScene.selectPreviewDialogue(request)
    )
  }

  previousDialogue(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<PreviewCommandResultVO>> {
    return this.handle(previewDialoguePlaybackSchema, input, access, '上一句已返回', (request) =>
      this.currentScene.playPreviousDialogue(request)
    )
  }

  nextDialogue(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<PreviewCommandResultVO>> {
    return this.handle(previewDialoguePlaybackSchema, input, access, '下一句已返回', (request) =>
      this.currentScene.playNextDialogue(request)
    )
  }

  close(input: unknown, access: IpcRequestAccess): Promise<AjaxResult<null>> {
    return this.handle(previewSessionSchema, input, access, '预览已关闭', async (request) => {
      await this.currentScene.closeScenePreview(request)
      return null
    })
  }

  async subscribe(
    input: unknown,
    access: IpcRequestAccess,
    listener: PreviewRuntimeListener
  ): Promise<{ accepted: AjaxResult<null>; unsubscribe?: () => void }> {
    let unsubscribe: (() => void) | undefined
    const accepted = await this.handle(
      subscribePreviewRuntimeSchema,
      input,
      access,
      '预览运行时已订阅',
      (request) => {
        unsubscribe = this.currentScene.subscribePreviewRuntime(request, listener)
        return null
      }
    )
    if (accepted.code !== ErrorCodes.success || !unsubscribe) {
      unsubscribe?.()
      return {
        accepted:
          accepted.code === ErrorCodes.success
            ? { code: ErrorCodes.internalError, msg: errorMessages[ErrorCodes.internalError] }
            : accepted
      }
    }
    return { accepted, unsubscribe }
  }

  readCandidate(input: unknown, access: IpcRequestAccess): Promise<AjaxResult<CandidatePreviewVO>> {
    return this.handle(readCandidatePreviewSchema, input, access, '候选预览已读取', (request) =>
      this.candidatePreview.readCandidatePreview(request)
    )
  }

  /**
   * 补投候选会话最后一条真实舞台事实。
   * 只返回与请求项目、场景和会话一致的事件；没有事件时返回 null。
   */
  readCandidateEvent(
    input: unknown,
    access: IpcRequestAccess,
    read: (previewSessionId: string) => SceneGenerationCandidatePreviewEventVO | undefined
  ): Promise<AjaxResult<SceneGenerationCandidatePreviewEventVO | null>> {
    return this.handle(
      readCandidatePreviewSchema,
      input,
      access,
      '候选预览事件已读取',
      (request) => {
        const event = read(request.previewSessionId)
        if (!event || event.projectId !== request.projectId || event.sceneId !== request.sceneId) {
          return null
        }
        return event
      }
    )
  }
}
