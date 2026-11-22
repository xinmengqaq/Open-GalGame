import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { DialogueEditPlan } from '@domain/scene-preview/models/DialogueEditPlan'
import { planDialogueTextEdits } from '@domain/scene-preview/services/planDialogueTextEdits'

import type {
  DialogueTextEditDTO,
  ReadDialogueSaveSettlementDTO,
  SaveDialogueChangesDTO
} from '../../dto/DialogueSaveDTO'
import { toSceneDialogueSnapshot } from '../../mapping/toSceneDialogueSnapshot'
import { previewSaveEditsSnapshot } from '../../models/PreviewSaveRequestState'
import type { ScenePreviewSourceFact } from '../../models/ScenePreviewSourceFact'
import type {
  PreparedDialogueRevision,
  SceneDialogueRevisionGateway
} from '../../ports/SceneDialogueRevisionGateway'
import type { ScenePreviewSourceGateway } from '../../ports/ScenePreviewSourceGateway'
import type { PreviewRuntimeGateway } from '../../ports/PreviewRuntimeGateway'
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
import type { SceneContentBasisVO } from '../../vo/ScenePreviewSessionVO'
import type { PreviewDialogueService } from './PreviewDialogueService'
import {
  previewError,
  previewFailure,
  rejectionFromDomain
} from './previewErrorMapping'
import {
  requireRequestId,
  requireSceneIdentity
} from './PreviewAvailabilityService'
import { observeStage, sameBasis } from './PreviewSessionService'
import type {
  ActivePreviewSession,
  ScenePreviewSessionStore
} from './ScenePreviewSessionStore'

export type PreviewSaveSettlementServiceDependencies = {
  readonly sources: ScenePreviewSourceGateway
  readonly revisions: SceneDialogueRevisionGateway
  readonly versions: PreviewSaveVersionGateway
  readonly runtime: PreviewRuntimeGateway
  readonly sessions: ScenePreviewSessionStore
  readonly dialogue: PreviewDialogueService
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

const SAVE_REFUSAL_CODES: readonly PreviewErrorCode[] = [
  'contentLocked',
  'dialogueObjectInvalid',
  'contentBasisChanged',
  'sessionClosed'
]

export class PreviewSaveSettlementService {
  constructor(private readonly deps: PreviewSaveSettlementServiceDependencies) {}

  async saveDialogueChanges(request: SaveDialogueChangesDTO): Promise<SaveDialogueChangesVO> {
    const opened = this.deps.sessions.find(request.previewSessionId)
    if (!opened || opened.closed) {
      const closed = opened
        ? { projectId: opened.source.location.projectId, sceneId: opened.source.location.sceneId }
        : this.deps.sessions.closedScene(request.previewSessionId)
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
    const session = this.deps.sessions.find(request.previewSessionId)
    if (!session || session.closed) {
      if (persisted) return persisted
      throw previewFailure('sessionClosed')
    }
    const running = this.deps.sessions.findAcceptedSave(work)
    if (running === 'conflict') throw previewFailure('saveRequestReused')
    if (running) return running.completion
    this.deps.sessions.rememberAcceptedSave(
      session.previewSessionId,
      work,
      Promise.resolve().then(() => completion)
    )
    const completion = session.saveTail.then(() =>
      this.executeSave(session.previewSessionId, work)
    )
    const queued = this.deps.sessions.bindSaveTail(
      session.previewSessionId,
      completion.then(
        () => undefined,
        () => undefined
      )
    )
    if (!queued) {
      this.deps.sessions.dropAcceptedSave(work)
      throw previewFailure('sessionClosed')
    }
    return completion
  }

  async readDialogueSaveSettlement(
    request: ReadDialogueSaveSettlementDTO
  ): Promise<DialogueSaveSettlementVO> {
    requireSceneIdentity(request.projectId, request.sceneId)
    requireRequestId(request.requestId)
    const running = this.deps.sessions.findAcceptedSaveForIdentity(request)
    if (running) {
      return {
        status: 'pendingVerification',
        request,
        failure: previewError('saveOutcomeUnknown')
      }
    }
    return this.deps.versions.readPreviewSaveSettlement(request)
  }

  private async executeSave(
    previewSessionId: string,
    work: SaveWork
  ): Promise<SaveDialogueChangesVO> {
    try {
      return await this.finishSave(previewSessionId, work)
    } finally {
      this.deps.sessions.dropAcceptedSave(work)
    }
  }

  private async finishSave(
    previewSessionId: string,
    work: SaveWork
  ): Promise<SaveDialogueChangesVO> {
    const started = this.deps.sessions.find(previewSessionId)
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
    const settled = this.deps.sessions.find(previewSessionId)
    let runtimeGeneration = committed.runtimeGeneration
    if (settled && !settled.closed) {
      const kept = new Map(
        [...settled.unsavedEdits].filter(
          ([id, draft]) =>
            !plan.changedEdits.some((edit) => edit.dialogueId === id) ||
            draft.editRevision > (work.draftRevisions?.get(id) ?? 0)
        )
      )
      this.deps.sessions.replace({
        ...settled,
        source: verified,
        unsavedEdits: kept,
        currentDialogueId: startedDialogueId
      })
      const overlayUpdate = await this.deps.dialogue.refreshSceneOverlay(
        settled.previewSessionId,
        kept
      )
      runtimeGeneration = this.nextRuntimeGeneration(previewSessionId)
      if (runtimeGeneration !== settled.runtimeGeneration) {
        await this.deps.runtime.rebaseSession({
          previewSessionId,
          contentBasis: verified.contentBasis,
          runtimeGeneration,
          scene: verified.parsed
        })
        const latest = this.deps.sessions.find(previewSessionId)
        if (latest && !latest.closed) {
          this.deps.sessions.replace({
            ...latest,
            runtimeGeneration,
            lastSequence: 0,
            lastConfirmed: undefined
          })
        }
      }
      if (overlayUpdate) return { ...committed, runtimeGeneration, previewUpdate: overlayUpdate }
    }
    const currentGeneration = this.deps.sessions.find(previewSessionId)?.runtimeGeneration
    if (currentGeneration !== undefined) runtimeGeneration = currentGeneration
    const previewUpdate = await this.deps.dialogue.refreshSavedDialogue(
      previewSessionId,
      startedDialogueId
    )
    if (previewUpdate.status === 'kept' && startedDialogueId) {
      const current = this.deps.sessions.find(previewSessionId)
      if (current && !current.closed) {
        const stage = observeStage(this.deps.sessions, current, {
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

  private nextRuntimeGeneration(previewSessionId: string): number {
    const session = this.deps.sessions.find(previewSessionId)
    if (!session || session.closed || !session.prepared) return session?.runtimeGeneration ?? 0
    return session.runtimeGeneration + 1
  }

  private async persistedSave(work: SaveWork): Promise<SaveDialogueChangesVO | undefined> {
    const settlement = await this.deps.versions.readPreviewSaveSettlement(work)
    if (settlement.status === 'notFound') return undefined
    if (settlement.status === 'conflict') {
      if (SAVE_REFUSAL_CODES.includes(settlement.failure.code)) {
        return { status: 'rejected', failure: settlement.failure }
      }
      return { status: 'rejected', failure: previewError('saveRequestReused') }
    }
    if (settlement.status === 'saved') {
      const current = this.deps.sessions.findByScene(work.projectId, work.sceneId)
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
    const session = this.deps.sessions.findByScene(work.projectId, work.sceneId)
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

function rejected(code: PreviewErrorCode): SaveDialogueChangesVO {
  return { status: 'rejected', failure: previewError(code) }
}

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
