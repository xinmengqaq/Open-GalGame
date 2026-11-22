import type {
  PreviewConfirmedStateVO,
  PreviewPhase,
  PreviewPositionVO,
  PreviewRuntimeEventVO
} from '@application/scene-preview/vo/PreviewRuntimeVO'
import type { PreviewErrorVO } from '@application/scene-preview/vo/PreviewErrorVO'
import type { PreviewSubscriptionRequest } from '@application/scene-preview/dto/PreviewPlaybackDTO'
import type { ReadCandidatePreviewDTO } from '@application/scene-preview/dto/ReadCandidatePreviewDTO'
import type { CandidatePreviewEventVO } from '@interfaces/scene-preview/contracts/ScenePreviewResponseSchema'
import type { ScenePreviewClient } from '@interfaces/scene-preview/client/ScenePreviewClient'

export type GameStageEventIdentity = Readonly<{
  previewSessionId: string
  projectId: string | null
  sceneId: string | null
  candidateSnapshotId: string | null
}>

export type GameStageRuntimePosition = Readonly<{
  runtimeGeneration: number
  phase: PreviewPhase
  position: PreviewPositionVO
}>

export type GameStageEvent = Readonly<{
  type: 'ready' | 'failed' | 'invalidated'
  sequence: number
  identity: GameStageEventIdentity
  runtime: GameStageRuntimePosition | null
  failure: PreviewErrorVO | null
  lastConfirmed: PreviewConfirmedStateVO | null
  message: string | null
}>

export function gameStageEventOfRuntime(
  event: PreviewRuntimeEventVO,
  expectedPreviewSessionId: string
): GameStageEvent | null {
  if (event.previewSessionId !== expectedPreviewSessionId) return null
  const identity: GameStageEventIdentity = {
    previewSessionId: event.previewSessionId,
    projectId: null,
    sceneId: null,
    candidateSnapshotId: null
  }
  if (event.type === 'stage') {
    return {
      type: 'ready',
      sequence: event.sequence,
      identity,
      runtime: {
        runtimeGeneration: event.runtimeGeneration,
        phase: event.phase,
        position: event.position
      },
      failure: null,
      lastConfirmed: null,
      message: null
    }
  }
  return {
    type: 'failed',
    sequence: event.sequence,
    identity,
    runtime: null,
    failure: event.failure,
    lastConfirmed: event.lastConfirmed,
    message: null
  }
}

export function gameStageEventOfCandidate(
  event: CandidatePreviewEventVO,
  expected: {
    readonly projectId: string
    readonly sceneId: string
    readonly previewSessionId: string
    readonly candidateSnapshotId: string
  }
): GameStageEvent | null {
  if (
    event.projectId !== expected.projectId ||
    event.sceneId !== expected.sceneId ||
    event.previewSessionId !== expected.previewSessionId ||
    event.candidateSnapshotId !== expected.candidateSnapshotId
  )
    return null
  return {
    type:
      event.type === 'ready' ? 'ready' : event.type === 'stageFailed' ? 'failed' : 'invalidated',
    sequence: event.sequence,
    identity: {
      previewSessionId: event.previewSessionId,
      projectId: event.projectId,
      sceneId: event.sceneId,
      candidateSnapshotId: event.candidateSnapshotId
    },
    runtime: null,
    failure: null,
    lastConfirmed: null,
    message: 'message' in event ? (event.message ?? null) : null
  }
}

type RuntimeStageClient = Pick<ScenePreviewClient, 'subscribeRuntime'>
type CandidateStageClient = Pick<ScenePreviewClient, 'subscribeCandidatePreview'>

export function subscribeRuntimeStage(
  client: RuntimeStageClient,
  scope: PreviewSubscriptionRequest,
  listener: (event: GameStageEvent) => void,
  onError?: (message: string) => void
): () => void {
  return client.subscribeRuntime(
    scope,
    (event) => {
      const stageEvent = gameStageEventOfRuntime(event, scope.previewSessionId)
      if (stageEvent !== null) listener(stageEvent)
    },
    onError
  )
}

export function subscribeCandidateStage(
  client: CandidateStageClient,
  scope: ReadCandidatePreviewDTO,
  expected: {
    readonly projectId: string
    readonly sceneId: string
    readonly previewSessionId: string
    readonly candidateSnapshotId: string
  },
  listener: (event: GameStageEvent) => void
): () => void {
  return client.subscribeCandidatePreview(scope, (event) => {
    const stageEvent = gameStageEventOfCandidate(event, expected)
    if (stageEvent !== null) listener(stageEvent)
  })
}
