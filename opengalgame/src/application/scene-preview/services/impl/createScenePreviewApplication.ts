import type { SceneDialogueRevisionGateway } from '../../ports/SceneDialogueRevisionGateway'
import type { ScenePreviewArtifactGateway } from '../../ports/ScenePreviewArtifactGateway'
import type { ScenePreviewSourceGateway } from '../../ports/ScenePreviewSourceGateway'
import type { PreviewRuntimeGateway } from '../../ports/PreviewRuntimeGateway'
import type { PreviewSaveVersionGateway } from '../../ports/PreviewSaveVersionGateway'
import type { ScenePreviewApplicationService } from '../ScenePreviewApplicationService'
import { PreviewAvailabilityService } from './PreviewAvailabilityService'
import { PreviewDialogueService } from './PreviewDialogueService'
import { PreviewSaveSettlementService } from './PreviewSaveSettlementService'
import { PreviewSessionService } from './PreviewSessionService'
import { ScenePreviewSessionStore } from './ScenePreviewSessionStore'

export type ScenePreviewApplicationDependencies = {
  readonly artifacts: ScenePreviewArtifactGateway
  readonly sources: ScenePreviewSourceGateway
  readonly revisions: SceneDialogueRevisionGateway
  readonly versions: PreviewSaveVersionGateway
  readonly runtime: PreviewRuntimeGateway
  readonly nextId: () => string
  readonly sessions?: ScenePreviewSessionStore
}

/**
 * 组合根：创建唯一的会话存储，向四个用例服务各注入同一实例，
 * 再把 11 个动作装配成外部消费的应用服务形状。
 */
export function createScenePreviewApplication(
  deps: ScenePreviewApplicationDependencies
): ScenePreviewApplicationService {
  const sessions = deps.sessions ?? new ScenePreviewSessionStore()
  const availability = new PreviewAvailabilityService({ artifacts: deps.artifacts })
  const session = new PreviewSessionService({
    artifacts: deps.artifacts,
    sources: deps.sources,
    runtime: deps.runtime,
    nextId: deps.nextId,
    sessions,
    availability
  })
  const dialogue = new PreviewDialogueService({ runtime: deps.runtime, sessions })
  const saveSettlement = new PreviewSaveSettlementService({
    sources: deps.sources,
    revisions: deps.revisions,
    versions: deps.versions,
    runtime: deps.runtime,
    sessions,
    dialogue
  })
  return {
    readScenePreviewAvailability: (request) =>
      availability.readScenePreviewAvailability(request),
    openScenePreview: (request) => session.openScenePreview(request),
    preparePreviewStage: (request) => session.preparePreviewStage(request),
    previewDialogueDraft: (request) => dialogue.previewDialogueDraft(request),
    saveDialogueChanges: (request) => saveSettlement.saveDialogueChanges(request),
    readDialogueSaveSettlement: (request) => saveSettlement.readDialogueSaveSettlement(request),
    selectPreviewDialogue: (request) => dialogue.selectPreviewDialogue(request),
    playPreviousDialogue: (request) => dialogue.playPreviousDialogue(request),
    playNextDialogue: (request) => dialogue.playNextDialogue(request),
    subscribePreviewRuntime: (request, listener) =>
      session.subscribePreviewRuntime(request, listener),
    closeScenePreview: (request) => session.closeScenePreview(request)
  }
}
