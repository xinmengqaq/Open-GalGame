import { createHash } from 'node:crypto'
import { basename } from 'node:path'

import type { ParsedSceneSentence, SceneSourceRange } from '@application/scenes/models/ParsedScene'
import type {
  DialogueTextEditDTO,
  PreviewDialogueDraftDTO
} from '../../dto/DialogueSaveDTO'
import type { PreviewDialoguePlaybackDTO } from '../../dto/PreviewPlaybackDTO'
import type { ScenePreviewSourceFact } from '../../models/ScenePreviewSourceFact'
import {
  SceneOverlayRejected,
  type PreviewRuntimeGateway
} from '../../ports/PreviewRuntimeGateway'
import type { PreviewUpdateVO } from '../../vo/DialogueSaveVO'
import type { PreviewErrorCode } from '../../vo/PreviewErrorVO'
import type {
  PreviewCommandResultVO,
  PreviewDraftResultVO
} from '../../vo/PreviewRuntimeVO'
import { previewError } from './previewErrorMapping'
import {
  observeStage,
  requireOpenSession,
  requireRunnable
} from './PreviewSessionService'
import type {
  ActivePreviewSession,
  ScenePreviewSessionStore
} from './ScenePreviewSessionStore'

export type PreviewDialogueServiceDependencies = {
  readonly runtime: PreviewRuntimeGateway
  readonly sessions: ScenePreviewSessionStore
}

/** 编排草稿覆盖、选句与前后句播放。 */
export class PreviewDialogueService {
  constructor(private readonly deps: PreviewDialogueServiceDependencies) {}

  async previewDialogueDraft(request: PreviewDialogueDraftDTO): Promise<PreviewDraftResultVO> {
    const session = requireOpenSession(this.deps.sessions, request.previewSessionId)
    if (!session.prepared) return { status: 'unavailable', reason: 'runtimeNotPrepared' }
    if (session.prepare !== 'ready') return { status: 'unavailable', reason: 'runtimeNotReady' }
    if (request.expectedRuntimeGeneration !== session.runtimeGeneration) {
      return { status: 'unavailable', reason: 'staleRuntimeGeneration' }
    }
    if (!Number.isSafeInteger(request.editRevision) || request.editRevision <= 0) {
      return { status: 'unavailable', reason: 'staleRuntimeGeneration' }
    }
    const dialogue = session.source.dialogues.find((item) => item.dialogueId === request.dialogueId)
    const sentence = dialogueSentence(session.source, request.dialogueId)
    if (!dialogue || !sentence || request.text.trim() === '') {
      return { status: 'unavailable', reason: 'dialogueNotMounted' }
    }
    if (!sentence.contentRange) return { status: 'unavailable', reason: 'dialogueNotMounted' }
    const current = session.unsavedEdits.get(request.dialogueId)
    if (current && request.editRevision <= current.editRevision) {
      return { status: 'unavailable', reason: 'staleRuntimeGeneration' }
    }
    const edits = new Map(session.unsavedEdits)
    edits.set(request.dialogueId, {
      dialogueId: request.dialogueId,
      text: request.text,
      editRevision: request.editRevision
    })
    const overlaid = overlayText(session.source, edits)
    if (!overlaid) return { status: 'unavailable', reason: 'dialogueNotMounted' }
    try {
      await this.deps.runtime.setSceneTextOverlay({
        previewSessionId: session.previewSessionId,
        sceneFileName: basename(session.source.location.entryFile.replaceAll('\\', '/')),
        editRevision: Math.max(...[...edits.values()].map((edit) => edit.editRevision)),
        text: overlaid,
        digest: createHash('sha256').update(overlaid, 'utf8').digest('hex'),
        runtimeGeneration: session.runtimeGeneration
      })
    } catch (error) {
      if (error instanceof SceneOverlayRejected) {
        return {
          status: 'unavailable',
          reason:
            error.code === 'staleRuntimeGeneration'
              ? 'staleRuntimeGeneration'
              : 'dialogueNotMounted'
        }
      }
      return { status: 'unavailable', reason: 'runtimeNotReady' }
    }
    this.deps.sessions.replace({ ...session, unsavedEdits: edits })
    const located = await this.playDialogue(request, request.dialogueId)
    if (located.status === 'failed') return { status: 'unavailable', reason: 'runtimeNotReady' }
    return {
      status: 'applied',
      dialogueId: request.dialogueId,
      editRevision: request.editRevision,
      runtimeGeneration: located.stage.runtimeGeneration,
      sequence: located.stage.sequence
    }
  }

  selectPreviewDialogue(request: PreviewDialoguePlaybackDTO): Promise<PreviewCommandResultVO> {
    return this.playDialogue(request, request.dialogueId)
  }

  playPreviousDialogue(request: PreviewDialoguePlaybackDTO): Promise<PreviewCommandResultVO> {
    return this.playAdjacentDialogue(request, -1)
  }

  playNextDialogue(request: PreviewDialoguePlaybackDTO): Promise<PreviewCommandResultVO> {
    return this.playAdjacentDialogue(request, 1)
  }

  async refreshSavedDialogue(
    previewSessionId: string,
    dialogueId: string | undefined
  ): Promise<PreviewUpdateVO> {
    const session = this.deps.sessions.find(previewSessionId)
    if (!session || session.closed) return { status: 'unavailable', reason: 'sessionClosed' }
    if (!session.prepared || session.prepare === 'failed') {
      return { status: 'unavailable', reason: 'stageNeverPrepared' }
    }
    if (session.prepare !== 'ready' || !dialogueId) {
      return { status: 'unavailable', reason: 'runtimeNotReady' }
    }
    const played = await this.deps.runtime.playDialogue({
      previewSessionId,
      expectedRuntimeGeneration: session.runtimeGeneration,
      dialogueId,
      scene: session.source.parsed
    })
    if (played.status === 'failed') return { status: 'failed', failure: played.failure }
    return {
      status: 'kept',
      stage: {
        ...played.stage,
        position: { kind: 'dialogue', dialogueId }
      }
    }
  }

  async refreshSceneOverlay(
    previewSessionId: string,
    edits: ReadonlyMap<string, DialogueTextEditDTO & { readonly editRevision: number }>
  ): Promise<PreviewUpdateVO | undefined> {
    const session = this.deps.sessions.find(previewSessionId)
    if (!session || session.closed || !session.prepared || session.prepare !== 'ready') return
    try {
      if (edits.size === 0) {
        await this.deps.runtime.clearSceneTextOverlay({
          previewSessionId,
          runtimeGeneration: session.runtimeGeneration
        })
        return
      }
      const text = overlayText(session.source, edits)
      if (!text) return { status: 'failed', failure: previewError('dialogueObjectInvalid') }
      const accepted = await this.deps.runtime.currentSceneTextOverlayRevision({
        previewSessionId,
        runtimeGeneration: session.runtimeGeneration
      })
      const editRevision = Math.max(
        accepted + 1,
        ...[...edits.values()].map((edit) => edit.editRevision)
      )
      await this.deps.runtime.setSceneTextOverlay({
        previewSessionId,
        sceneFileName: basename(session.source.location.entryFile.replaceAll('\\', '/')),
        editRevision,
        text,
        digest: createHash('sha256').update(text, 'utf8').digest('hex'),
        runtimeGeneration: session.runtimeGeneration
      })
    } catch (error) {
      if (error instanceof SceneOverlayRejected) {
        return { status: 'failed', failure: previewError(error.code) }
      }
      return { status: 'unavailable', reason: 'runtimeNotReady' }
    }
    return undefined
  }

  private async playAdjacentDialogue(
    request: PreviewDialoguePlaybackDTO,
    direction: -1 | 1
  ): Promise<PreviewCommandResultVO> {
    const session = requireRunnable(this.deps.sessions, request)
    const dialogues = session.source.dialogues
    const currentIndex = dialogues.findIndex(
      (item) => item.dialogueId === session.currentDialogueId
    )
    const target = dialogues[currentIndex + direction]
    if (currentIndex < 0 || !target) return failedCommand('playbackCompleted')
    return this.playDialogue(request, target.dialogueId)
  }

  private async playDialogue(
    request: PreviewDialoguePlaybackDTO,
    dialogueId: string,
    refreshed?: ActivePreviewSession
  ): Promise<PreviewCommandResultVO> {
    const session = requireRunnable(this.deps.sessions, request)
    if (!session.source.dialogues.some((item) => item.dialogueId === dialogueId)) {
      return failedCommand('dialogueObjectInvalid')
    }
    const result = await this.deps.runtime.playDialogue({
      previewSessionId: session.previewSessionId,
      expectedRuntimeGeneration: session.runtimeGeneration,
      dialogueId,
      scene: refreshed?.source.parsed ?? session.source.parsed
    })
    if (result.status === 'failed') return result
    const current = this.deps.sessions.find(session.previewSessionId)
    if (
      !current ||
      result.stage.runtimeGeneration !== current.runtimeGeneration ||
      result.stage.position.kind !== 'dialogue' ||
      result.stage.position.dialogueId !== dialogueId
    ) {
      return failedCommand('staleRuntimeGeneration')
    }
    const stage = observeStage(this.deps.sessions, current, result.stage)
    const latest = this.deps.sessions.find(session.previewSessionId) ?? current
    this.deps.sessions.replace({
      ...latest,
      currentDialogueId: dialogueId
    })
    return { status: 'confirmed', stage }
  }
}

function dialogueSentence(
  source: ScenePreviewSourceFact,
  dialogueId: string
): ParsedSceneSentence | undefined {
  return source.parsed.sentences.find(
    (sentence) =>
      sentence.command === 'say' &&
      !sentence.isLineBreakHolder &&
      String(sentence.sequence) === dialogueId
  )
}

function overlayText(
  source: ScenePreviewSourceFact,
  edits: ReadonlyMap<string, DialogueTextEditDTO & { readonly editRevision: number }>
): string | undefined {
  const file = source.snapshot.files.find(
    (item) => item.relativePath === source.parsed.sourceFile.relativePath
  )
  if (!file?.text) return undefined
  const replacements: { range: SceneSourceRange; text: string }[] = []
  for (const edit of edits.values()) {
    const sentence = dialogueSentence(source, edit.dialogueId)
    if (!sentence?.contentRange) return undefined
    const current = file.text.slice(
      sentence.contentRange.startOffset,
      sentence.contentRange.endOffset
    )
    if (current !== sentence.rawContent) return undefined
    replacements.push({ range: sentence.contentRange, text: edit.text })
  }
  replacements.sort((left, right) => right.range.startOffset - left.range.startOffset)
  let text = file.text
  for (const replacement of replacements) {
    text =
      text.slice(0, replacement.range.startOffset) +
      replacement.text +
      text.slice(replacement.range.endOffset)
  }
  return text
}

function failedCommand(code: PreviewErrorCode): PreviewCommandResultVO {
  return { status: 'failed', failure: previewError(code) }
}
