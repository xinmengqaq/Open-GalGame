import type { SceneGenerationRenderStatusVO } from '@application/scene-generation/vo/SceneGenerationRenderVO'
import type {
  CandidatePreviewIssueVO,
  CandidatePreviewVO
} from '@application/scene-preview/vo/CandidatePreviewVO'
import type { GameStageEvent } from '@presentation/features/game-stage/gameStageEvents'

import { isTerminalState } from '../generation/generationPresentation'

export type CandidatePreviewTarget = Readonly<{
  projectId: string
  sceneId: string
  operationId: string
  threadId: string
  branchId: string
  checkpointId: string
  candidateSnapshotId: string
}>

export function candidatePreviewTargetOf(
  status: SceneGenerationRenderStatusVO | null
): CandidatePreviewTarget | null {
  if (!status || !status.previewAvailable) return null
  const readOnlyTerminal = isCandidateReadOnlyTerminal(status)
  const interaction = status.interaction
  if (readOnlyTerminal) {
    if (status.previewAuthorization !== 'readOnly') return null
  } else {
    if (interaction === undefined) return null
    if (interaction.kind !== 'review' && interaction.kind !== 'correction') return null
    if (status.checkpointId !== undefined && interaction.checkpointId !== status.checkpointId) {
      return null
    }
    if (
      status.candidateSnapshotId !== undefined &&
      interaction.candidateSnapshotId !== undefined &&
      interaction.candidateSnapshotId !== status.candidateSnapshotId
    ) {
      return null
    }
  }
  const candidateSnapshotId = readOnlyTerminal
    ? status.candidateSnapshotId
    : (interaction?.candidateSnapshotId ?? status.candidateSnapshotId)
  const checkpointId = readOnlyTerminal
    ? status.checkpointId
    : (interaction?.checkpointId ?? status.checkpointId)
  if (!candidateSnapshotId || !checkpointId) return null
  return {
    projectId: status.projectId,
    sceneId: status.sceneId,
    operationId: status.operationId,
    threadId: status.threadId,
    branchId: status.branchId,
    checkpointId,
    candidateSnapshotId
  }
}

function isCandidateReadOnlyTerminal(status: SceneGenerationRenderStatusVO): boolean {
  return isTerminalState(status.state) || (status.state === 'interrupted' && status.stage !== 'paused')
}

export function candidatePreviewTargetKey(target: CandidatePreviewTarget): string {
  return [
    target.projectId,
    target.sceneId,
    target.operationId,
    target.threadId,
    target.branchId,
    target.checkpointId,
    target.candidateSnapshotId
  ].join('|')
}

export type CandidatePreviewLifecycle =
  'idle' | 'opening' | 'open' | 'invalidated' | 'expired' | 'failed' | 'unsupported'

export type CandidatePreviewStage = 'idle' | 'ready' | 'failed'

export type CandidatePreviewRead = 'idle' | 'loading' | 'ready' | 'failed'

export type CandidatePreviewPhase =
  | 'opening'
  | 'ready'
  | 'read-failed'
  | 'stage-failed'
  | 'invalidated'
  | 'expired'
  | 'failed'
  | 'unsupported'

export type CandidatePreviewState = {
  readonly lifecycle: CandidatePreviewLifecycle
  readonly stage: CandidatePreviewStage
  readonly read: CandidatePreviewRead
  readonly projectId: string | null
  readonly sceneId: string | null
  readonly sessionId: string | null
  readonly candidateSnapshotId: string | null
  readonly sceneName: string | null
  readonly stageUrl: string | null
  readonly expiresAt: number | null
  readonly issues: readonly CandidatePreviewIssueVO[]
  readonly readMessage: string | null
  readonly failureMessage: string | null
  readonly stageFailureMessage: string | null
  readonly lastSequence: number
  readonly frameToken: number
  readonly openingStalled: boolean
}

export const initialCandidatePreviewState: CandidatePreviewState = {
  lifecycle: 'idle',
  stage: 'idle',
  read: 'idle',
  projectId: null,
  sceneId: null,
  sessionId: null,
  candidateSnapshotId: null,
  sceneName: null,
  stageUrl: null,
  expiresAt: null,
  issues: [],
  readMessage: null,
  failureMessage: null,
  stageFailureMessage: null,
  lastSequence: 0,
  frameToken: 0,
  openingStalled: false
}

export type CandidatePreviewAction =
  | { readonly type: 'reset' }
  | {
      readonly type: 'start'
      readonly projectId: string
      readonly sceneId: string
      readonly candidateSnapshotId: string
    }
  | {
      readonly type: 'opened'
      readonly projectId: string
      readonly sceneId: string
      readonly sessionId: string
      readonly candidateSnapshotId: string
      readonly stageUrl: string
      readonly expiresAt: number | null
    }
  | { readonly type: 'open-failed'; readonly message: string; readonly unsupported: boolean }
  | { readonly type: 'read-started' }
  | { readonly type: 'read-succeeded'; readonly preview: CandidatePreviewVO }
  | {
      readonly type: 'read-failed'
      readonly message: string
      readonly sessionRejected: boolean
    }
  | { readonly type: 'event'; readonly event: GameStageEvent }
  | { readonly type: 'expire' }
  | { readonly type: 'reload-stage' }
  | { readonly type: 'opening-stalled' }

export const candidateOpeningStallMs = 15_000

const candidateSessionRejectionCodes: readonly number[] = [
  4511,
  4512,
  4513
]

export function isCandidateSessionRejection(code: number): boolean {
  return candidateSessionRejectionCodes.includes(code)
}

export function candidatePreviewReducer(
  state: CandidatePreviewState,
  action: CandidatePreviewAction
): CandidatePreviewState {
  switch (action.type) {
    case 'reset':
      return initialCandidatePreviewState
    case 'start': {
      const sameCandidate =
        state.projectId === action.projectId &&
        state.sceneId === action.sceneId &&
        state.candidateSnapshotId === action.candidateSnapshotId
      return {
        ...initialCandidatePreviewState,
        lifecycle: 'opening',
        projectId: action.projectId,
        sceneId: action.sceneId,
        candidateSnapshotId: action.candidateSnapshotId,
        ...(sameCandidate ? { sceneName: state.sceneName, issues: state.issues } : {})
      }
    }
    case 'opened':
      if (state.lifecycle !== 'opening') return state
      if (state.projectId !== action.projectId || state.sceneId !== action.sceneId) return state
      return {
        ...state,
        lifecycle: 'open',
        sessionId: action.sessionId,
        candidateSnapshotId: action.candidateSnapshotId,
        stageUrl: action.stageUrl,
        expiresAt: action.expiresAt,
        stage: 'idle',
        read: 'idle',
        readMessage: null,
        failureMessage: null,
        stageFailureMessage: null,
        lastSequence: 0
      }
    case 'open-failed':
      if (state.lifecycle !== 'opening') return state
      return {
        ...initialCandidatePreviewState,
        lifecycle: action.unsupported ? 'unsupported' : 'failed',
        projectId: state.projectId,
        sceneId: state.sceneId,
        candidateSnapshotId: state.candidateSnapshotId,
        failureMessage: action.message
      }
    case 'read-started':
      if (state.lifecycle !== 'open') return state
      return { ...state, read: 'loading', readMessage: null }
    case 'read-succeeded': {
      if (state.lifecycle !== 'open') return state
      const preview = action.preview
      if (!preview.readOnly) return state
      if (preview.projectId !== state.projectId || preview.sceneId !== state.sceneId) return state
      if (
        preview.candidate.previewSessionId !== state.sessionId ||
        preview.candidate.candidateSnapshotId !== state.candidateSnapshotId
      )
        return state
      return {
        ...state,
        read: 'ready',
        readMessage: null,
        sceneName: preview.sceneName,
        issues: preview.issues
      }
    }
    case 'read-failed':
      if (state.lifecycle !== 'open') return state
      if (action.sessionRejected) return runtimeExpiredState(state)
      return { ...state, read: 'failed', readMessage: action.message, issues: [] }
    case 'event':
      return applyCandidateEvent(state, action.event)
    case 'expire':
      if (state.lifecycle !== 'open') return state
      return runtimeExpiredState(state)
    case 'reload-stage':
      if (state.lifecycle !== 'open' || state.stageUrl === null) return state
      return { ...state, frameToken: state.frameToken + 1 }
    case 'opening-stalled':
      if (candidatePreviewPhaseOf(state) !== 'opening' || state.openingStalled) return state
      return { ...state, openingStalled: true }
    default:
      return state
  }
}

function runtimeExpiredState(state: CandidatePreviewState): CandidatePreviewState {
  const readReady = state.read === 'ready'
  return {
    ...state,
    lifecycle: 'expired',
    stage: 'idle',
    read: readReady ? 'ready' : 'idle',
    readMessage: null,
    stageUrl: null,
    expiresAt: null,
    stageFailureMessage: null
  }
}

function applyCandidateEvent(
  state: CandidatePreviewState,
  event: GameStageEvent
): CandidatePreviewState {
  if (state.lifecycle !== 'open') return state
  const identity = event.identity
  if (
    !state.sessionId ||
    identity.previewSessionId !== state.sessionId ||
    identity.candidateSnapshotId !== state.candidateSnapshotId ||
    identity.projectId !== state.projectId ||
    identity.sceneId !== state.sceneId
  )
    return state
  if (event.sequence <= state.lastSequence) return state
  if (event.type === 'invalidated') {
    return {
      ...state,
      lifecycle: 'invalidated',
      stage: 'idle',
      read: 'idle',
      stageUrl: null,
      issues: [],
      readMessage: null,
      stageFailureMessage: null,
      lastSequence: event.sequence
    }
  }
  if (event.type === 'ready') {
    return {
      ...state,
      stage: 'ready',
      stageFailureMessage: null,
      lastSequence: event.sequence
    }
  }
  return {
    ...state,
    stage: 'failed',
    stageFailureMessage: stageFailureMessageOf(event.message),
    lastSequence: event.sequence
  }
}

const stageFailureMessages = [
  '当前引擎不支持开始游戏',
  '宿主无法开始游戏',
  '游戏没有离开当前画面',
  '游戏没有进入场景',
  '游戏尚未注册',
  '游戏加载超时',
  '游戏连接已断开',
  '游戏加载失败'
] as const

function stageFailureMessageOf(message: string | null): string | null {
  if (message === null) return null
  return stageFailureMessages.some((safe) => safe === message) ? message : null
}

export function candidatePreviewPhaseOf(
  state: CandidatePreviewState
): CandidatePreviewPhase | null {
  switch (state.lifecycle) {
    case 'idle':
      return null
    case 'opening':
      return 'opening'
    case 'invalidated':
    case 'expired':
    case 'failed':
    case 'unsupported':
      return state.lifecycle
    case 'open':
      if (state.read === 'failed') return 'read-failed'
      if (state.stage === 'failed') return 'stage-failed'
      if (state.stage === 'ready') return 'ready'
      return 'opening'
    default:
      return null
  }
}

export function candidateShortId(candidateSnapshotId: string | null): string | null {
  if (!candidateSnapshotId) return null
  return candidateSnapshotId.slice(0, 8)
}

export function candidateTabBadgeOf(state: CandidatePreviewState): {
  readonly count: number
  readonly live: boolean
} {
  const phase = candidatePreviewPhaseOf(state)
  const count =
    phase !== null && state.read === 'ready' && phase !== 'invalidated' ? state.issues.length : 0
  const live = count === 0 && (phase === 'opening' || phase === 'ready')
  return { count, live }
}

export function candidateEntryHintOf(
  phase: CandidatePreviewPhase | null,
  openingStalled = false
): string {
  switch (phase) {
    case 'opening':
      return openingStalled ? '仍在启动游戏画面，打开后可以重新打开' : '正在打开只读游戏画面'
    case 'ready':
      return '查看真实游戏画面与读取问题'
    case 'stage-failed':
      return '游戏加载失败，打开后可以重新运行'
    case 'read-failed':
      return '打开后可以重新读取'
    case 'expired':
      return '运行会话已过期，打开后可以重新运行'
    case 'invalidated':
      return '候选已更新，打开后可以查看新的候选'
    case 'failed':
      return '候选暂时打不开，打开后可以重新尝试'
    case 'unsupported':
      return '当前环境不支持游戏预览'
    case null:
      return '打开只读游戏候选'
    default:
      return '打开只读游戏候选'
  }
}
