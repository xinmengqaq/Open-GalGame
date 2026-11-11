import type { SceneGenerationRenderStatusVO } from '@application/scene-generation/vo/SceneGenerationRenderVO'
import type {
  CandidatePreviewIssueVO,
  CandidatePreviewVO
} from '@application/scene-preview/vo/CandidatePreviewVO'
import type { GameStageEvent } from '@presentation/features/game-stage/gameStageEvents'

import { isTerminalState } from '../generation/generationPresentation'

/**
 * 候选会话的打开身份。全部来自后端安全投影，渲染层不补路径、入口或 Git 修订；
 * `checkpointId` 与 `candidateSnapshotId` 一起证明这是当前交互对应的已发布候选。
 */
export type CandidatePreviewTarget = Readonly<{
  projectId: string
  sceneId: string
  operationId: string
  threadId: string
  branchId: string
  checkpointId: string
  candidateSnapshotId: string
}>

/**
 * 审阅或修正交互绑定当前候选时产生目标；失败、取消和待核对中断后只凭后端明确的
 * 只读授权和完整候选身份产生同一类目标，不再要求仍然存在的交互。
 * 暂停仍走恢复语义，不从只读授权取候选；不按场景图片、历史摘要或本地状态推测候选。
 */
export function candidatePreviewTargetOf(
  status: SceneGenerationRenderStatusVO | null
): CandidatePreviewTarget | null {
  if (!status || !status.previewAvailable) return null
  const readOnlyTerminal = isCandidateReadOnlyTerminal(status)
  const interaction = status.interaction
  if (readOnlyTerminal) {
    // 终态只认后端明确写下的只读授权；旧记录缺该事实时不从残留交互推断。
    if (status.previewAuthorization !== 'readOnly') return null
  } else {
    if (interaction === undefined) return null
    if (interaction.kind !== 'review' && interaction.kind !== 'correction') return null
    // 与 P4-1 的打开资格一致：交互身份和当前状态不一致时不能按过期身份打开候选。
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

/**
 * 失败、取消和待核对中断的只读候选范围。暂停仍可恢复，不按只读终态处理；
 * 与 `GenerationRunView.candidate` 的打开资格保持同一判定。
 */
function isCandidateReadOnlyTerminal(status: SceneGenerationRenderStatusVO): boolean {
  return isTerminalState(status.state) || (status.state === 'interrupted' && status.stage !== 'paused')
}

/** 切换或重新打开时用它判断是否仍是同一候选；任一身份变化都必须重开会话。 */
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

/**
 * 候选晚到响应和旧事件按会话与候选双重核对。成功结果还要满足只读契约，
 * 不把非只读或别的会话结果拼进当前舞台。
 */
export type CandidatePreviewLifecycle =
  'idle' | 'opening' | 'open' | 'invalidated' | 'expired' | 'failed' | 'unsupported'

export type CandidatePreviewStage = 'idle' | 'ready' | 'failed'

export type CandidatePreviewRead = 'idle' | 'loading' | 'ready' | 'failed'

/** 界面一次只显示一个主状态；就绪、读取失败和游戏失败互斥，读取问题数量另列。 */
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
  /** 只在嵌入容器内部使用，不进入可见文案、错误消息或可访问名称。 */
  readonly stageUrl: string | null
  readonly expiresAt: number | null
  readonly issues: readonly CandidatePreviewIssueVO[]
  readonly readMessage: string | null
  /** 打开或启动请求失败，不表示舞台已经打开后加载失败。 */
  readonly failureMessage: string | null
  /** 只保存白名单内的舞台失败说明；未映射文本按没有原因处理。 */
  readonly stageFailureMessage: string | null
  readonly lastSequence: number
  /** 同一会话重新载入舞台实例的计数；只重建 iframe，不改变候选、会话和读取结果。 */
  readonly frameToken: number
  /**
   * 打开或等待画面就绪超过冻结阈值。只影响提示和“重新打开”动作，
   * 不改变会话、候选和读取结果，也不代表失败。
   */
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

/**
 * 打开候选到画面就绪的安全看护阈值（冻结 15 秒）。
 * 超过后只把界面切到“仍在启动游戏画面”并给出重新打开动作；不判定失败，
 * 不自动取消会话，也不伪造 ready 或错误事件。
 */
export const candidateOpeningStallMs = 15_000

/** 会话拒绝读不到候选时，重开才是有效动作，不能原地重试。 */
const candidateSessionRejectionCodes: readonly number[] = [
  4511, // ScenePreviewErrorCodes.candidateSessionMissing
  4512, // ScenePreviewErrorCodes.candidateSessionExpired
  4513 // ScenePreviewErrorCodes.candidateSessionMismatch
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
      // 只有仍停在“打开中/等待画面就绪”时才提示等待较久；就绪、失败和终态都不改。
      if (candidatePreviewPhaseOf(state) !== 'opening' || state.openingStalled) return state
      return { ...state, openingStalled: true }
    default:
      return state
  }
}

/**
 * 运行时到期只关闭游戏运行。候选身份、已读完成的内容和问题是审阅依据，必须保留；
 * 读取中或读取失败不是可审阅事实，回到 idle 并清空说明，避免过期后仍显示“正在读取/读取失败”。
 */
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

/**
 * 事件消息来自长度受限但未封闭的契约，展示前只接受后端已发布的固定安全说明。
 * 错误码、路径、堆栈和未映射引擎文本都视为没有原因。
 */
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

/** 候选短标识只取前 8 位；完整候选与会话身份不进入界面。 */
export function candidateShortId(candidateSnapshotId: string | null): string | null {
  if (!candidateSnapshotId) return null
  return candidateSnapshotId.slice(0, 8)
}

/**
 * 标签角标只显示真实读取到的问题数；没有问题时用活动点表示正在打开或已就绪。
 * 读取失败和已失效不保留旧问题数，避免把上一次结果挂在标签上。
 */
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

/** 审阅气泡里的入口只描述当前会话阶段，不重复标签内的完整状态行。 */
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
