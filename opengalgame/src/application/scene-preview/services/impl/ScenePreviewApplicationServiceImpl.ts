import { createHash } from 'node:crypto'
import { basename } from 'node:path'

import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { DialogueEditPlan } from '@domain/scene-preview/models/DialogueEditPlan'
import { planDialogueTextEdits } from '@domain/scene-preview/services/planDialogueTextEdits'
import type { ParsedSceneSentence, SceneSourceRange } from '../../../scenes/models/ParsedScene'

import type {
  DialogueTextEditDTO,
  PreviewDialogueDraftDTO,
  ReadDialogueSaveSettlementDTO,
  SaveDialogueChangesDTO
} from '../../dto/DialogueSaveDTO'
import type {
  PreviewDialoguePlaybackDTO,
  PreviewSessionRef,
  PreviewSubscriptionRequest
} from '../../dto/PreviewPlaybackDTO'
import type { ReadScenePreviewAvailabilityDTO } from '../../dto/ScenePreviewAvailabilityDTO'
import type { OpenScenePreviewDTO, PreparePreviewStageDTO } from '../../dto/ScenePreviewSessionDTO'
import { toSceneDialogueSnapshot } from '../../mapping/toSceneDialogueSnapshot'
import { previewSaveEditsSnapshot } from '../../models/PreviewSaveRequestState'
import type { ScenePreviewSourceFact } from '../../models/ScenePreviewSourceFact'
import type { PreparedDialogueRevision } from '../../ports/SceneDialogueRevisionGateway'
import type { SceneDialogueRevisionGateway } from '../../ports/SceneDialogueRevisionGateway'
import type { ScenePreviewArtifactGateway } from '../../ports/ScenePreviewArtifactGateway'
import type { ScenePreviewSourceGateway } from '../../ports/ScenePreviewSourceGateway'
import type { PreviewRuntimeGateway } from '../../ports/PreviewRuntimeGateway'
import { SceneOverlayRejected } from '../../ports/PreviewRuntimeGateway'
import type {
  PreviewSaveCommitResult,
  PreviewSaveVersionGateway
} from '../../ports/PreviewSaveVersionGateway'
import type {
  DialogueSaveSettlementVO,
  PreviewUpdateVO,
  SaveDialogueChangesVO
} from '../../vo/DialogueSaveVO'
import type { PreviewErrorCode, PreviewErrorVO } from '../../vo/PreviewErrorVO'
import type {
  PreviewCommandResultVO,
  PreviewDraftResultVO,
  PreviewRuntimeEventVO,
  PreviewRuntimeListener,
  PreviewStageResultVO,
  PreviewStageVO
} from '../../vo/PreviewRuntimeVO'
import type { ScenePreviewAvailabilityVO } from '../../vo/ScenePreviewAvailabilityVO'
import type {
  SceneContentBasisVO,
  SceneDialogueVO,
  ScenePreviewSessionVO
} from '../../vo/ScenePreviewSessionVO'
import type { ScenePreviewApplicationService } from '../ScenePreviewApplicationService'
import {
  openFailureCode,
  previewError,
  previewFailure,
  rejectionFromDomain
} from './previewErrorMapping'
import { ScenePreviewSessionStore, type ActivePreviewSession } from './ScenePreviewSessionStore'

export interface ScenePreviewApplicationDependencies {
  readonly artifacts: ScenePreviewArtifactGateway
  readonly sources: ScenePreviewSourceGateway
  readonly revisions: SceneDialogueRevisionGateway
  readonly versions: PreviewSaveVersionGateway
  readonly runtime: PreviewRuntimeGateway
  readonly nextId: () => string
}

type SaveWork = {
  readonly projectId: string
  readonly sceneId: string
  readonly requestId: string
  readonly baseDigest: string
  readonly editsSnapshot: string
  readonly edits: readonly DialogueTextEditDTO[]
  readonly currentDialogueId?: string
  readonly draftRevisions?: ReadonlyMap<string, number>
}

const blockedMessages = {
  noArtifact: '当前场景还没有可预览的内容',
  readUnavailable: '当前场景暂时无法读取'
} as const

/**
 * 编排当前场景预览。
 * 内存只管理活动会话和正在执行的保存；持久身份与结算只问版本端口。
 */
export class ScenePreviewApplicationServiceImpl implements ScenePreviewApplicationService {
  private readonly sessions = new ScenePreviewSessionStore()
  private readonly listeners = new Map<string, Set<PreviewRuntimeListener>>()

  constructor(private readonly deps: ScenePreviewApplicationDependencies) {}

  async readScenePreviewAvailability(
    request: ReadScenePreviewAvailabilityDTO
  ): Promise<ScenePreviewAvailabilityVO> {
    requireSceneIdentity(request.projectId, request.sceneId)
    let report: Awaited<ReturnType<ScenePreviewArtifactGateway['readSceneArtifact']>>
    try {
      report = await this.deps.artifacts.readSceneArtifact(request)
    } catch (error) {
      if (error instanceof AppException) {
        return {
          status: 'blocked',
          reason: 'sceneUnavailable',
          message: '当前场景不可用'
        }
      }
      return {
        status: 'blocked',
        reason: 'readUnavailable',
        message: blockedMessages.readUnavailable
      }
    }
    if (report.status === 'available') return { status: 'available' }
    const reason = report.status === 'missing' ? 'noArtifact' : 'readUnavailable'
    return { status: 'blocked', reason, message: blockedMessages[reason] }
  }

  async openScenePreview(request: OpenScenePreviewDTO): Promise<ScenePreviewSessionVO> {
    requireSceneIdentity(request.projectId, request.sceneId)
    const availability = await this.readScenePreviewAvailability(request)
    if (availability.status === 'blocked' && availability.reason === 'sceneUnavailable') {
      throw previewFailure('sceneUnavailable')
    }
    const report = await this.deps.artifacts.readSceneArtifact(request)
    if (report.status === 'missing') throw previewFailure('sceneArtifactMissing')
    if (report.status === 'unreadable') throw previewFailure('contentUnreadable')
    let source: ScenePreviewSourceFact
    try {
      source = await this.deps.sources.readScenePreviewSource(request)
    } catch (error) {
      throw previewFailure(openFailureCode(error))
    }
    if (source.contentBasis.digest !== source.snapshot.digest) {
      throw previewFailure('contentUnreadable')
    }
    return sessionView(this.sessions.create(this.deps.nextId(), source))
  }

  async preparePreviewStage(request: PreparePreviewStageDTO): Promise<PreviewStageResultVO> {
    const session = this.requireOpenSession(request.previewSessionId)
    if (session.prepared || session.prepare === 'preparing') {
      return failedStage('prepareAlreadyDone')
    }
    const dialogueId = session.source.dialogues[0]?.dialogueId
    if (!dialogueId) return failedStage('prepareFailed')
    const generation = session.runtimeGeneration + 1
    this.sessions.replace({
      ...session,
      prepare: 'preparing',
      prepared: false,
      runtimeGeneration: generation,
      lastSequence: 0,
      currentDialogueId: undefined
    })
    const result = await this.deps.runtime.prepare({
      previewSessionId: session.previewSessionId,
      contentBasis: session.source.contentBasis,
      runtimeGeneration: generation,
      projectRoot: session.source.location.projectRoot,
      entryFile: session.source.location.entryFile,
      scene: session.source.parsed,
      dialogueId
    })
    const current = this.sessions.find(session.previewSessionId)
    if (!current || current.runtimeGeneration !== generation || current.closed) {
      return failedStage('prepareFailed')
    }
    if (
      result.status === 'failed' ||
      result.stage.runtimeGeneration !== generation ||
      result.stage.phase !== 'unknown' ||
      result.stage.position.kind !== 'unknown' ||
      !sameBasis(result.stage.contentBasis, current.source.contentBasis)
    ) {
      this.sessions.replace({ ...current, prepare: 'failed', prepared: false })
      const failure = result.status === 'failed' ? result.failure : previewError('prepareFailed')
      this.emitFailure(current, failure, generation)
      return { status: 'failed', failure }
    }
    const stage = this.observeStage(current, result.stage)
    this.sessions.replace({
      ...this.requireLive(session.previewSessionId),
      prepare: 'ready',
      prepared: true,
      currentDialogueId: dialogueId
    })
    return { status: 'ready', stage, stageUrl: result.stageUrl }
  }

  async previewDialogueDraft(request: PreviewDialogueDraftDTO): Promise<PreviewDraftResultVO> {
    const session = this.requireOpenSession(request.previewSessionId)
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
    this.sessions.replace({ ...session, unsavedEdits: edits })
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

  async saveDialogueChanges(request: SaveDialogueChangesDTO): Promise<SaveDialogueChangesVO> {
    const opened = this.sessions.find(request.previewSessionId)
    if (!opened || opened.closed) {
      const closed = opened
        ? { projectId: opened.source.location.projectId, sceneId: opened.source.location.sceneId }
        : this.sessions.closedScene(request.previewSessionId)
      const persisted = closed
        ? await this.persistedSave(closedSaveWork(closed, request))
        : undefined
      if (persisted) return persisted
      throw previewFailure(closed ? 'sessionClosed' : 'sessionNotFound')
    }
    const work = saveWork(opened, request)
    const persisted = await this.persistedSave(work)
    if (persisted?.status === 'rejected' && persisted.failure.code === 'saveRequestReused') {
      throw previewFailure('saveRequestReused')
    }
    const session = this.sessions.find(request.previewSessionId)
    if (!session || session.closed) {
      if (persisted) return persisted
      throw previewFailure('sessionClosed')
    }
    const running = this.sessions.findAcceptedSave(work)
    if (running === 'conflict') throw previewFailure('saveRequestReused')
    if (running) return running.completion
    let completion!: Promise<SaveDialogueChangesVO>
    this.sessions.rememberAcceptedSave(
      session.previewSessionId,
      work,
      Promise.resolve().then(() => completion)
    )
    completion = session.saveTail.then(() => this.executeSave(session.previewSessionId, work))
    const queued = this.sessions.bindSaveTail(
      session.previewSessionId,
      completion.then(
        () => undefined,
        () => undefined
      )
    )
    if (!queued) {
      this.sessions.dropAcceptedSave(work)
      throw previewFailure('sessionClosed')
    }
    return completion
  }

  async readDialogueSaveSettlement(
    request: ReadDialogueSaveSettlementDTO
  ): Promise<DialogueSaveSettlementVO> {
    requireSceneIdentity(request.projectId, request.sceneId)
    requireRequestId(request.requestId)
    const running = this.sessions.findAcceptedSaveForIdentity(request)
    if (running) {
      return {
        status: 'pendingVerification',
        request,
        failure: previewError('saveOutcomeUnknown')
      }
    }
    return this.deps.versions.readPreviewSaveSettlement(request)
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

  subscribePreviewRuntime(
    request: PreviewSubscriptionRequest,
    listener: PreviewRuntimeListener
  ): () => void {
    this.requirePreviewSubscription(request)
    let stopped = false
    const unsubscribe = this.deps.runtime.subscribe(request, (event) => {
      if (stopped || !this.visibleEvent(request.previewSessionId, event)) return
      const session = this.sessions.find(request.previewSessionId)
      if (!session || session.closed) return
      if (event.sequence > session.lastSequence) {
        this.sessions.replace({ ...session, lastSequence: event.sequence })
      }
      try {
        listener(event)
      } catch {
        // 监听器异常不中断运行时。
      }
    })
    return () => {
      if (stopped) return
      stopped = true
      unsubscribe()
    }
  }

  private requirePreviewSubscription(request: PreviewSubscriptionRequest): void {
    const session = this.requireOpenSession(request.previewSessionId)
    if (
      session.source.location.projectId !== request.projectId ||
      session.source.location.sceneId !== request.sceneId
    ) {
      throw previewFailure('sessionNotFound')
    }
  }

  async closeScenePreview(request: PreviewSessionRef): Promise<void> {
    const session = this.sessions.find(request.previewSessionId)
    if (!session || session.closed) return
    this.sessions.replace({ ...session, closed: true })
    this.listeners.delete(request.previewSessionId)
    await this.release(request.previewSessionId)
  }

  private async executeSave(
    previewSessionId: string,
    work: SaveWork
  ): Promise<SaveDialogueChangesVO> {
    try {
      return await this.finishSave(previewSessionId, work)
    } finally {
      this.sessions.dropAcceptedSave(work)
    }
  }

  private async finishSave(
    previewSessionId: string,
    work: SaveWork
  ): Promise<SaveDialogueChangesVO> {
    const started = this.sessions.find(previewSessionId)
    const startedDialogueId = work.currentDialogueId ?? started?.source.dialogues[0]?.dialogueId
    if (!started) return this.closedBeforeCommit(work)
    const repeated = await this.persistedSave(work)
    if (repeated) return repeated
    const fresh = await this.readCurrent(started)
    if (!fresh) return rejected('contentUnreadable')
    if (fresh.contentBasis.digest !== work.baseDigest) return rejected('contentBasisChanged')
    if (fresh.lockState !== 'editable') return rejected('contentLocked')
    const plan = this.plan(fresh, work.edits)
    if ('failure' in plan) return { status: 'rejected', failure: plan.failure }
    if (plan.changedEdits.length === 0) {
      return {
        status: 'unchanged',
        contentBasis: fresh.contentBasis,
        confirmedEdits: plan.unchangedEdits
      }
    }
    const prepared = await this.revision(fresh, plan)
    if (!prepared) return pendingResult(work)
    if ('failure' in prepared) {
      await this.deps.versions.recordPreviewSaveRefusal({
        ...work,
        baseContentBasis: fresh.contentBasis,
        committedEdits: plan.changedEdits,
        failure: prepared.failure
      })
      return { status: 'rejected', failure: prepared.failure }
    }
    const revision = prepared
    const committed = await this.commit(
      work,
      fresh.contentBasis,
      plan.changedEdits,
      revision,
      this.nextRuntimeGeneration(previewSessionId)
    )
    if (committed.status !== 'saved') return committed
    const verified = await this.readCurrent(started)
    let persisted: SaveDialogueChangesVO | undefined
    try {
      persisted = await this.persistedSave(work)
    } catch {
      persisted = undefined
    }
    if (!saveVerified(fresh, verified, committed, persisted, plan, revision)) {
      return pendingResult(work)
    }
    const settled = this.sessions.find(previewSessionId)
    let runtimeGeneration = committed.runtimeGeneration
    if (settled && !settled.closed) {
      const kept = new Map(
        [...settled.unsavedEdits].filter(
          ([id, draft]) =>
            !plan.changedEdits.some((edit) => edit.dialogueId === id) ||
            draft.editRevision > (work.draftRevisions?.get(id) ?? 0)
        )
      )
      this.sessions.replace({
        ...settled,
        source: verified,
        unsavedEdits: kept,
        currentDialogueId: startedDialogueId
      })
      const overlayUpdate = await this.refreshSceneOverlay(settled.previewSessionId, kept)
      runtimeGeneration = this.nextRuntimeGeneration(previewSessionId)
      if (runtimeGeneration !== settled.runtimeGeneration) {
        await this.deps.runtime.rebaseSession({
          previewSessionId,
          contentBasis: verified.contentBasis,
          runtimeGeneration,
          scene: verified.parsed
        })
        const latest = this.sessions.find(previewSessionId)
        if (latest && !latest.closed) {
          this.sessions.replace({
            ...latest,
            runtimeGeneration,
            lastSequence: 0,
            lastConfirmed: undefined
          })
        }
      }
      if (overlayUpdate) return { ...committed, runtimeGeneration, previewUpdate: overlayUpdate }
    }
    const currentGeneration = this.sessions.find(previewSessionId)?.runtimeGeneration
    if (currentGeneration !== undefined) runtimeGeneration = currentGeneration
    const previewUpdate = await this.refreshSavedDialogue(previewSessionId, startedDialogueId)
    if (previewUpdate.status === 'kept' && startedDialogueId) {
      const current = this.sessions.find(previewSessionId)
      if (current && !current.closed) {
        const stage = this.observeStage(current, {
          ...previewUpdate.stage,
          position: { kind: 'dialogue', dialogueId: startedDialogueId }
        })
        return {
          ...committed,
          runtimeGeneration,
          previewUpdate: {
            status: 'kept',
            stage: {
              ...stage,
              position: { kind: 'dialogue', dialogueId: startedDialogueId }
            }
          }
        }
      }
    }
    return { ...committed, runtimeGeneration, previewUpdate }
  }

  private async closedBeforeCommit(work: SaveWork): Promise<SaveDialogueChangesVO> {
    const failure = previewError('sessionClosed')
    try {
      const source = await this.deps.sources.readScenePreviewSource({
        projectId: work.projectId,
        sceneId: work.sceneId
      })
      await this.deps.versions.recordPreviewSaveRefusal({
        ...work,
        baseContentBasis: source.contentBasis,
        committedEdits: work.edits,
        failure
      })
    } catch {
      return pendingResult(work)
    }
    return { status: 'rejected', failure }
  }

  private async revision(
    source: ScenePreviewSourceFact,
    plan: DialogueEditPlan
  ): Promise<PreparedDialogueRevision | { failure: PreviewErrorVO } | undefined> {
    try {
      return await this.deps.revisions.prepareDialogueRevision(source, plan)
    } catch (error) {
      if (error instanceof AppException && error.code === ErrorCodes.invalidRequest) {
        return { failure: previewError('dialogueObjectInvalid') }
      }
      return undefined
    }
  }

  private async commit(
    work: SaveWork,
    baseContentBasis: SceneContentBasisVO,
    committedEdits: readonly DialogueTextEditDTO[],
    revision: PreparedDialogueRevision,
    runtimeGeneration: number
  ): Promise<SaveDialogueChangesVO> {
    let result: PreviewSaveCommitResult
    try {
      result = await this.deps.versions.commitPreviewSave({
        ...work,
        baseContentBasis,
        committedEdits,
        revision
      })
    } catch {
      return pendingResult(work)
    }
    if (result.status === 'pendingVerification') return pendingResult(work)
    if (result.status === 'rejected') return { status: 'rejected', failure: result.failure }
    if (result.status === 'unchanged') {
      return {
        status: 'unchanged',
        contentBasis: result.contentBasis,
        confirmedEdits: committedEdits
      }
    }
    return {
      status: 'saved',
      contentBasis: result.contentBasis,
      runtimeGeneration,
      committedEdits,
      previewUpdate: { status: 'unavailable', reason: 'runtimeNotReady' }
    }
  }

  /**
   * 只有已经准备的会话才拥有可换代的舞台。
   * 没准备时保留当前值，避免保存结果宣称一个不存在的运行时。
   */
  private nextRuntimeGeneration(previewSessionId: string): number {
    const session = this.sessions.find(previewSessionId)
    if (!session || session.closed || !session.prepared) return session?.runtimeGeneration ?? 0
    return session.runtimeGeneration + 1
  }

  private async refreshSavedDialogue(
    previewSessionId: string,
    dialogueId: string | undefined
  ): Promise<PreviewUpdateVO> {
    const session = this.sessions.find(previewSessionId)
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

  private async refreshSceneOverlay(
    previewSessionId: string,
    edits: ReadonlyMap<string, DialogueTextEditDTO & { readonly editRevision: number }>
  ): Promise<PreviewUpdateVO | undefined> {
    const session = this.sessions.find(previewSessionId)
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

  private async persistedSave(work: SaveWork): Promise<SaveDialogueChangesVO | undefined> {
    const settlement = await this.deps.versions.readPreviewSaveSettlement(work)
    if (settlement.status === 'notFound') return undefined
    if (settlement.status === 'conflict') {
      if (
        settlement.failure.code === 'contentLocked' ||
        settlement.failure.code === 'dialogueObjectInvalid' ||
        settlement.failure.code === 'contentBasisChanged' ||
        settlement.failure.code === 'sessionClosed'
      ) {
        return { status: 'rejected', failure: settlement.failure }
      }
      return { status: 'rejected', failure: previewError('saveRequestReused') }
    }
    if (settlement.status === 'saved') {
      const current = this.sessions.findByScene(work.projectId, work.sceneId)
      return {
        ...settlement,
        runtimeGeneration: current && !current.closed ? current.runtimeGeneration : 0,
        previewUpdate: this.currentSavedUpdate(work)
      }
    }
    if (settlement.status === 'unchanged' || settlement.status === 'pendingVerification') {
      return settlement
    }
    return { status: 'rejected', failure: settlement.failure }
  }

  private currentSavedUpdate(work: SaveWork): PreviewUpdateVO {
    const session = this.sessions.findByScene(work.projectId, work.sceneId)
    if (!session || session.closed) return { status: 'unavailable', reason: 'sessionClosed' }
    if (!session.prepared || session.prepare === 'failed') {
      return { status: 'unavailable', reason: 'stageNeverPrepared' }
    }
    const confirmed = session.lastConfirmed
    if (
      session.prepare !== 'ready' ||
      !session.currentDialogueId ||
      !confirmed ||
      confirmed.position.kind !== 'dialogue' ||
      confirmed.position.dialogueId !== session.currentDialogueId
    ) {
      return { status: 'unavailable', reason: 'runtimeNotReady' }
    }
    return {
      status: 'kept',
      stage: {
        previewSessionId: session.previewSessionId,
        contentBasis: session.source.contentBasis,
        runtimeGeneration: session.runtimeGeneration,
        sequence: session.lastSequence,
        phase: confirmed.phase,
        position: confirmed.position
      }
    }
  }

  private async playAdjacentDialogue(
    request: PreviewDialoguePlaybackDTO,
    direction: -1 | 1
  ): Promise<PreviewCommandResultVO> {
    const session = this.requireRunnable(request)
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
    const session = this.requireRunnable(request)
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
    const current = this.sessions.find(session.previewSessionId)
    if (
      !current ||
      result.stage.runtimeGeneration !== current.runtimeGeneration ||
      result.stage.position.kind !== 'dialogue' ||
      result.stage.position.dialogueId !== dialogueId
    ) {
      return failedCommand('staleRuntimeGeneration')
    }
    const stage = this.observeStage(current, result.stage)
    const latest = this.sessions.find(session.previewSessionId) ?? current
    this.sessions.replace({
      ...latest,
      currentDialogueId: dialogueId
    })
    return { status: 'confirmed', stage }
  }

  private observeStage(session: ActivePreviewSession, stage: PreviewStageVO): PreviewStageVO {
    const current = this.sessions.find(session.previewSessionId) ?? session
    const base = current
    const confirmed = {
      ...base,
      lastConfirmed: { phase: stage.phase, position: stage.position }
    }
    if (
      stage.runtimeGeneration !== current.runtimeGeneration ||
      !sameBasis(stage.contentBasis, base.source.contentBasis) ||
      stage.sequence <= current.lastSequence
    ) {
      this.sessions.replace(confirmed)
      return stage
    }
    this.sessions.replace({ ...confirmed, lastSequence: stage.sequence })
    this.emit({ type: 'stage', ...stage })
    return stage
  }

  private visibleEvent(previewSessionId: string, event: PreviewRuntimeEventVO): boolean {
    const session = this.sessions.find(previewSessionId)
    if (!session || session.closed || session.runtimeGeneration === 0) return false
    return (
      event.previewSessionId === session.previewSessionId &&
      event.runtimeGeneration === session.runtimeGeneration &&
      sameBasis(event.contentBasis, session.source.contentBasis) &&
      event.sequence > session.lastSequence
    )
  }

  private emitFailure(
    session: ActivePreviewSession,
    failure: PreviewErrorVO,
    generation: number
  ): void {
    const sequence = session.lastSequence + 1
    this.sessions.replace({ ...session, lastSequence: sequence, runtimeGeneration: generation })
    this.emit({
      type: 'failed',
      previewSessionId: session.previewSessionId,
      contentBasis: session.source.contentBasis,
      runtimeGeneration: generation,
      sequence,
      failure,
      lastConfirmed: { kind: 'unknown' }
    })
  }
  private emit(event: PreviewRuntimeEventVO): void {
    for (const listener of this.listeners.get(event.previewSessionId) ?? []) {
      try {
        listener(event)
      } catch {
        // 单个监听器失败不中断其余监听器。
      }
    }
  }

  private async release(previewSessionId: string): Promise<void> {
    const session = this.sessions.find(previewSessionId)
    if (!session || session.runtimeReleased) return
    this.sessions.replace({ ...session, runtimeReleased: true, closed: true })
    this.listeners.delete(previewSessionId)
    await this.deps.runtime.release({ previewSessionId })
    const current = this.sessions.find(previewSessionId)
    if (!current?.closed) return
    this.sessions.remove(previewSessionId)
  }

  private async readCurrent(
    session: ActivePreviewSession
  ): Promise<ScenePreviewSourceFact | undefined> {
    try {
      return await this.deps.sources.readScenePreviewSource(session.source.location)
    } catch {
      return undefined
    }
  }

  private plan(
    source: ScenePreviewSourceFact,
    edits: readonly DialogueTextEditDTO[]
  ): DialogueEditPlan | { failure: PreviewErrorVO } {
    try {
      return planDialogueTextEdits(
        toSceneDialogueSnapshot(source.location, source.lockState, source.dialogues),
        edits
      )
    } catch (error) {
      return { failure: rejectionFromDomain(error) ?? previewError('dialogueObjectInvalid') }
    }
  }

  private requireRunnable(request: PreviewDialoguePlaybackDTO): ActivePreviewSession {
    const session = this.requireOpenSession(request.previewSessionId)
    if (!session.prepared) throw previewFailure('runtimeNotPrepared')
    if (session.prepare !== 'ready') throw previewFailure('runtimeNotReady')
    if (request.expectedRuntimeGeneration !== session.runtimeGeneration) {
      throw previewFailure('staleRuntimeGeneration')
    }
    return session
  }

  private requireOpenSession(previewSessionId: string): ActivePreviewSession {
    const session = this.requireKnownSession(previewSessionId)
    if (session.closed) throw previewFailure('sessionClosed')
    return session
  }

  private requireKnownSession(previewSessionId: string): ActivePreviewSession {
    const session = this.sessions.find(previewSessionId)
    if (!session) throw previewFailure('sessionNotFound')
    return session
  }

  private requireLive(previewSessionId: string): ActivePreviewSession {
    const session = this.sessions.find(previewSessionId)
    if (!session) throw previewFailure('sessionClosed')
    return session
  }
}

function requireSceneIdentity(projectId: string, sceneId: string): void {
  if (projectId.trim() === '' || sceneId.trim() === '') throw previewFailure('invalidRequest')
}

function requireRequestId(requestId: string): void {
  if (requestId.trim() === '') throw previewFailure('invalidRequest')
}

function closedSaveWork(
  identity: { projectId: string; sceneId: string },
  request: SaveDialogueChangesDTO
): SaveWork {
  requireSceneIdentity(identity.projectId, identity.sceneId)
  requireRequestId(request.requestId)
  if (!Array.isArray(request.edits) || request.edits.length === 0) {
    throw previewFailure('invalidRequest')
  }
  return {
    projectId: identity.projectId,
    sceneId: identity.sceneId,
    requestId: request.requestId,
    baseDigest: request.baseContentBasis.digest,
    editsSnapshot: previewSaveEditsSnapshot(request.edits),
    edits: request.edits.map((edit) => ({ dialogueId: edit.dialogueId, text: edit.text }))
  }
}

function saveWork(session: ActivePreviewSession, request: SaveDialogueChangesDTO): SaveWork {
  requireRequestId(request.requestId)
  if (!Array.isArray(request.edits) || request.edits.length === 0) {
    throw previewFailure('invalidRequest')
  }
  return {
    projectId: session.source.location.projectId,
    sceneId: session.source.location.sceneId,
    requestId: request.requestId,
    baseDigest: request.baseContentBasis.digest,
    editsSnapshot: previewSaveEditsSnapshot(request.edits),
    edits: request.edits.map((edit) => ({ dialogueId: edit.dialogueId, text: edit.text })),
    currentDialogueId: session.currentDialogueId,
    draftRevisions: new Map(
      [...session.unsavedEdits].map(([id, draft]) => [id, draft.editRevision])
    )
  }
}

function sessionView(session: ActivePreviewSession): ScenePreviewSessionVO {
  const source = session.source
  const dialogues: SceneDialogueVO[] = toSceneDialogueSnapshot(
    source.location,
    source.lockState,
    source.dialogues
  ).dialogues.map((dialogue) => ({
    dialogueId: dialogue.dialogueId,
    text: dialogue.text,
    editable: dialogue.editable
  }))
  return {
    previewSessionId: session.previewSessionId,
    projectId: source.location.projectId,
    sceneId: source.location.sceneId,
    sceneName: source.sceneName,
    contentBasis: source.contentBasis,
    lockState: source.lockState,
    dialogues,
    issues: source.issues
  }
}

function sameBasis(left: SceneContentBasisVO, right: SceneContentBasisVO): boolean {
  return (
    left.digest === right.digest &&
    left.parserVersion === right.parserVersion &&
    left.engineVersion === right.engineVersion
  )
}

function rejected(code: PreviewErrorCode): SaveDialogueChangesVO {
  return { status: 'rejected', failure: previewError(code) }
}

/**
 * 保存结果、持久结算和回读必须是同一份源快照依据。
 * 修订文件字节也必须等于本次提交的修订摘要，正式源文件仍是权威。
 */
function saveVerified(
  before: ScenePreviewSourceFact,
  verified: ScenePreviewSourceFact | undefined,
  committed: Extract<SaveDialogueChangesVO, { status: 'saved' }>,
  persisted: SaveDialogueChangesVO | undefined,
  plan: DialogueEditPlan,
  revision: PreparedDialogueRevision
): verified is ScenePreviewSourceFact {
  if (!verified || !persisted || persisted.status !== 'saved') return false
  if (!sameBasis(persisted.contentBasis, committed.contentBasis)) return false
  if (!sameBasis(verified.contentBasis, committed.contentBasis)) return false
  if (verified.contentBasis.digest !== verified.snapshot.digest) return false
  if (before.dialogues.length !== verified.dialogues.length) return false
  const mapped = before.dialogues.every((dialogue, index) => {
    const current = verified.dialogues[index]
    if (!current || current.dialogueId !== dialogue.dialogueId) return false
    const changed = plan.changedEdits.find((edit) => edit.dialogueId === dialogue.dialogueId)
    return current.text === (changed?.text ?? dialogue.text)
  })
  if (!mapped) return false
  const written = verified.snapshot.files.find(
    (file) => file.relativePath === revision.relativePath
  )
  return written?.digest === revision.digest
}

function failedStage(code: PreviewErrorCode): PreviewStageResultVO {
  return { status: 'failed', failure: previewError(code) }
}

function failedCommand(code: PreviewErrorCode): PreviewCommandResultVO {
  return { status: 'failed', failure: previewError(code) }
}

function pendingResult(work: SaveWork): SaveDialogueChangesVO {
  return {
    status: 'pendingVerification',
    request: {
      projectId: work.projectId,
      sceneId: work.sceneId,
      requestId: work.requestId
    },
    failure: previewError('saveOutcomeUnknown')
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
