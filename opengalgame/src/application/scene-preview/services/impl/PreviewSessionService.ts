import { toSceneDialogueSnapshot } from '../../mapping/toSceneDialogueSnapshot'
import type {
  PreviewDialoguePlaybackDTO,
  PreviewSessionRef,
  PreviewSubscriptionRequest
} from '../../dto/PreviewPlaybackDTO'
import type {
  OpenScenePreviewDTO,
  PreparePreviewStageDTO
} from '../../dto/ScenePreviewSessionDTO'
import type { ScenePreviewArtifactGateway } from '../../ports/ScenePreviewArtifactGateway'
import type { ScenePreviewSourceFact } from '../../models/ScenePreviewSourceFact'
import type { ScenePreviewSourceGateway } from '../../ports/ScenePreviewSourceGateway'
import type { PreviewRuntimeGateway } from '../../ports/PreviewRuntimeGateway'
import type { PreviewErrorCode } from '../../vo/PreviewErrorVO'
import type {
  PreviewRuntimeEventVO,
  PreviewRuntimeListener,
  PreviewStageResultVO,
  PreviewStageVO
} from '../../vo/PreviewRuntimeVO'
import type {
  SceneContentBasisVO,
  SceneDialogueVO,
  ScenePreviewSessionVO
} from '../../vo/ScenePreviewSessionVO'
import { openFailureCode, previewError, previewFailure } from './previewErrorMapping'
import {
  requireSceneIdentity,
  type PreviewAvailabilityService
} from './PreviewAvailabilityService'
import type {
  ActivePreviewSession,
  ScenePreviewSessionStore
} from './ScenePreviewSessionStore'

export type PreviewSessionServiceDependencies = {
  readonly artifacts: ScenePreviewArtifactGateway
  readonly sources: ScenePreviewSourceGateway
  readonly runtime: PreviewRuntimeGateway
  readonly nextId: () => string
  readonly sessions: ScenePreviewSessionStore
  readonly availability: Pick<PreviewAvailabilityService, 'readScenePreviewAvailability'>
}

export class PreviewSessionService {
  constructor(private readonly deps: PreviewSessionServiceDependencies) {}

  async openScenePreview(request: OpenScenePreviewDTO): Promise<ScenePreviewSessionVO> {
    requireSceneIdentity(request.projectId, request.sceneId)
    const availability = await this.deps.availability.readScenePreviewAvailability(request)
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
    return sessionView(this.deps.sessions.create(this.deps.nextId(), source))
  }

  async preparePreviewStage(request: PreparePreviewStageDTO): Promise<PreviewStageResultVO> {
    const session = requireOpenSession(this.deps.sessions, request.previewSessionId)
    if (session.prepared || session.prepare === 'preparing') {
      return failedStage('prepareAlreadyDone')
    }
    const dialogueId = session.source.dialogues[0]?.dialogueId
    if (!dialogueId) return failedStage('prepareFailed')
    const generation = session.runtimeGeneration + 1
    this.deps.sessions.replace({
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
    const current = this.deps.sessions.find(session.previewSessionId)
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
      const failed: ActivePreviewSession = { ...current, prepare: 'failed', prepared: false }
      this.deps.sessions.replace(failed)
      const failure = result.status === 'failed' ? result.failure : previewError('prepareFailed')
      this.emitFailure(failed, generation)
      return { status: 'failed', failure }
    }
    const stage = observeStage(this.deps.sessions, current, result.stage)
    this.deps.sessions.replace({
      ...requireLive(this.deps.sessions, session.previewSessionId),
      prepare: 'ready',
      prepared: true,
      currentDialogueId: dialogueId
    })
    return { status: 'ready', stage, stageUrl: result.stageUrl }
  }

  subscribePreviewRuntime(
    request: PreviewSubscriptionRequest,
    listener: PreviewRuntimeListener
  ): () => void {
    requirePreviewSubscription(this.deps.sessions, request)
    let stopped = false
    const unsubscribe = this.deps.runtime.subscribe(request, (event) => {
      if (stopped || !visibleEvent(this.deps.sessions, request.previewSessionId, event)) return
      const session = this.deps.sessions.find(request.previewSessionId)
      if (!session || session.closed) return
      if (event.sequence > session.lastSequence) {
        this.deps.sessions.replace({ ...session, lastSequence: event.sequence })
      }
      try {
        listener(event)
      } catch {
      }
    })
    return () => {
      if (stopped) return
      stopped = true
      unsubscribe()
    }
  }

  async closeScenePreview(request: PreviewSessionRef): Promise<void> {
    const session = this.deps.sessions.find(request.previewSessionId)
    if (!session || session.closed) return
    this.deps.sessions.replace({ ...session, closed: true })
    await this.release(request.previewSessionId)
  }

  private emitFailure(session: ActivePreviewSession, generation: number): void {
    const sequence = session.lastSequence + 1
    this.deps.sessions.replace({ ...session, lastSequence: sequence, runtimeGeneration: generation })
  }

  private async release(previewSessionId: string): Promise<void> {
    const session = this.deps.sessions.find(previewSessionId)
    if (!session || session.runtimeReleased) return
    this.deps.sessions.replace({ ...session, runtimeReleased: true, closed: true })
    await this.deps.runtime.release({ previewSessionId })
    const current = this.deps.sessions.find(previewSessionId)
    if (!current?.closed) return
    this.deps.sessions.remove(previewSessionId)
  }
}

function requirePreviewSubscription(
  sessions: ScenePreviewSessionStore,
  request: PreviewSubscriptionRequest
): void {
  const session = requireOpenSession(sessions, request.previewSessionId)
  if (
    session.source.location.projectId !== request.projectId ||
    session.source.location.sceneId !== request.sceneId
  ) {
    throw previewFailure('sessionNotFound')
  }
}

export function visibleEvent(
  sessions: ScenePreviewSessionStore,
  previewSessionId: string,
  event: PreviewRuntimeEventVO
): boolean {
  const session = sessions.find(previewSessionId)
  if (!session || session.closed || session.runtimeGeneration === 0) return false
  return (
    event.previewSessionId === session.previewSessionId &&
    event.runtimeGeneration === session.runtimeGeneration &&
    sameBasis(event.contentBasis, session.source.contentBasis) &&
    event.sequence > session.lastSequence
  )
}

export function observeStage(
  sessions: ScenePreviewSessionStore,
  session: ActivePreviewSession,
  stage: PreviewStageVO
): PreviewStageVO {
  const current = sessions.find(session.previewSessionId) ?? session
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
    sessions.replace(confirmed)
    return stage
  }
  sessions.replace({ ...confirmed, lastSequence: stage.sequence })
  return stage
}

export function requireRunnable(
  sessions: ScenePreviewSessionStore,
  request: PreviewDialoguePlaybackDTO
): ActivePreviewSession {
  const session = requireOpenSession(sessions, request.previewSessionId)
  if (!session.prepared) throw previewFailure('runtimeNotPrepared')
  if (session.prepare !== 'ready') throw previewFailure('runtimeNotReady')
  if (request.expectedRuntimeGeneration !== session.runtimeGeneration) {
    throw previewFailure('staleRuntimeGeneration')
  }
  return session
}

export function requireOpenSession(
  sessions: ScenePreviewSessionStore,
  previewSessionId: string
): ActivePreviewSession {
  const session = requireKnownSession(sessions, previewSessionId)
  if (session.closed) throw previewFailure('sessionClosed')
  return session
}

function requireKnownSession(
  sessions: ScenePreviewSessionStore,
  previewSessionId: string
): ActivePreviewSession {
  const session = sessions.find(previewSessionId)
  if (!session) throw previewFailure('sessionNotFound')
  return session
}

function requireLive(
  sessions: ScenePreviewSessionStore,
  previewSessionId: string
): ActivePreviewSession {
  const session = sessions.find(previewSessionId)
  if (!session) throw previewFailure('sessionClosed')
  return session
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

export function sameBasis(left: SceneContentBasisVO, right: SceneContentBasisVO): boolean {
  return (
    left.digest === right.digest &&
    left.parserVersion === right.parserVersion &&
    left.engineVersion === right.engineVersion
  )
}

function failedStage(code: PreviewErrorCode): PreviewStageResultVO {
  return { status: 'failed', failure: previewError(code) }
}
