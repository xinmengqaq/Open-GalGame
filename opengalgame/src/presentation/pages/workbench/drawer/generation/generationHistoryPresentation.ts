import type {
  SceneGenerationFailureReasonVO,
  SceneGenerationHistoryBoundary,
  SceneGenerationHistorySummaryVO,
  SceneGenerationRenderStage,
  SceneGenerationRenderStatusVO
} from '@application/scene-generation/vo/SceneGenerationRenderVO'

import {
  failureClassOfLegacyReason,
  failureClassTitle,
  generationPhaseOf,
  isTerminalState,
  statusPillOf,
  waitingModelNote,
  type GenerationPhase,
  type GenerationTone
} from './generationPresentation'
import type { ForkFromHistoryOutcome } from './useGenerationActions'

export type HistoryBoundaryTone = 'live' | 'wait' | 'done' | 'danger' | 'muted'

export type HistoryViewState = 'loading' | 'error' | 'empty' | 'ready'

export const historyPageSize = 20

export const historyReadonlyNote =
  '这里只显示后端保存的操作摘要，不包含完整对话、候选内容或提交结果。'

/**
 * 分叉已创建但页面没有切过去：只报告创建事实和找回路径，不提供“重试”语义。
 * 再次创建是明确的新意图，不是对上一次失败的补偿；新分支仍在处理时，
 * 同线程分叉会被后端拒绝，因此不展示重复创建入口。
 */
export const historyForkCreatedTitle = '新分支已创建'
export const historyForkCreatedMessage =
  '没有自动切换到新分支。原记录和正式作品保持不变；新分支已创建，可从 AI 历史找到。'
export const historyForkCreatedHint =
  '已有分支不受影响；如果这是新的分叉意图，可以再创建一条。'
export const historyForkCreatedActiveHint =
  '新分支仍在处理中；结束前不能从同一对话再创建分支。已有分支不受影响。'
export const historyForkRefreshAction = '刷新历史查看'
export const historyForkCreateAgainAction = '再创建一条分支'

/**
 * 分叉通信未知：分支可能已创建。重新核对只刷新历史和发现，不猜测哪条新记录
 * 来自本次请求；未知提示保留到作者显式确认。
 */
export const historyForkUnconfirmedTitle = '分叉结果仍待确认'
export const historyForkUnconfirmedMessage =
  '没有收到创建结果，分支可能已经创建；原记录和正式作品保持不变。'
export const historyForkUnconfirmedPending =
  '先刷新 AI 历史与待处理发现，核对是否出现新分支；不要直接重复创建。'
export const historyForkUnconfirmedChecking =
  '正在重新读取 AI 历史与待处理发现，读取完成前不能确认结果。'
export const historyForkUnconfirmedRechecked =
  '已重新读取 AI 历史与待处理发现；如果本次已经创建，新分支会出现在历史里。仍不能据此确认本次结果。'
export const historyForkUnconfirmedFailed =
  '重新读取 AI 历史与待处理发现失败，请重试；未知结果仍然保留。'
export const historyForkRecheckAction = '重新核对'
export const historyForkRecheckingAction = '正在重新读取…'
export const historyForkViewListAction = '返回列表查看'
export const historyForkUnknownBannerTitle = '分叉结果仍待确认'
export const historyForkUnknownBannerPending =
  '分支可能已经创建。请核对下面的历史与待处理记录，不要直接重复创建。'
export const historyForkUnknownBannerRechecked =
  '已重新读取 AI 历史与待处理发现。如果本次已经创建，新分支会出现在下面的记录中；仍不能据此确认是哪一次创建。'
export const historyForkUnknownBannerFailed = '重新读取失败，请重试；未知结果仍然保留。'
export const historyForkAcknowledgeAction = '我已核对'

export type HistoryForkCheckStatus = 'unknown' | 'checking' | 'rechecked' | 'failed'

/** 详情内的核对状态文案；只有两个读取都完成且成功才会出现“已重新读取”。 */
export function historyForkUnconfirmedStatusCopy(
  status: HistoryForkCheckStatus,
  failureMessage: string | null
): string {
  if (status === 'checking') return historyForkUnconfirmedChecking
  if (status === 'rechecked') return historyForkUnconfirmedRechecked
  if (status === 'failed') {
    return failureMessage === null
      ? historyForkUnconfirmedFailed
      : `${historyForkUnconfirmedFailed}（${failureMessage}）`
  }
  return historyForkUnconfirmedPending
}

/** 列表横幅的核对状态文案；失败时保留未知并允许重试。 */
export function historyForkUnknownBannerStatusCopy(
  status: HistoryForkCheckStatus,
  failureMessage: string | null
): string {
  if (status === 'checking') return historyForkUnconfirmedChecking
  if (status === 'rechecked') return historyForkUnknownBannerRechecked
  if (status === 'failed') {
    return failureMessage === null
      ? historyForkUnknownBannerFailed
      : `${historyForkUnknownBannerFailed}（${failureMessage}）`
  }
  return historyForkUnknownBannerPending
}

/** 分叉动作的内联反馈：创建但未切换保持成功语义；失败与结果未明分开投影。 */
export type HistoryForkFeedback =
  | { kind: 'created'; branchActive: boolean }
  | {
      kind: 'unconfirmed'
      message: string
      checkStatus: HistoryForkCheckStatus
      failureMessage: string | null
    }
  | { kind: 'failed'; message: string }

export function historyForkFeedbackOf(
  outcome: ForkFromHistoryOutcome
): HistoryForkFeedback | null {
  if (outcome.kind === 'forked') {
    return outcome.viewSwitched
      ? null
      : {
          kind: 'created',
          branchActive: !isTerminalState(outcome.fork.status.state)
        }
  }
  if (outcome.kind === 'failed') {
    return outcome.unverified
      ? {
          kind: 'unconfirmed',
          message: outcome.message,
          checkStatus: 'unknown',
          failureMessage: null
        }
      : { kind: 'failed', message: outcome.message }
  }
  return null
}

const pendingVerificationMessages: ReadonlySet<string> = new Set([
  '提交结果待核对',
  '候选写入结果待核对',
  '候选或基线冲突，需要重新核对'
])

export const historyPendingVerificationLabel = '待核对'
export const historyPendingVerificationStage = '等待核对'

const boundaryLabels: Record<SceneGenerationHistoryBoundary, string> = {
  started: '开始',
  candidateCreated: '候选已创建',
  waitingDecision: '等待决定',
  waitingReview: '等待审阅',
  paused: '已暂停',
  committed: '已提交',
  failed: '失败',
  cancelled: '已取消'
}

const boundaryTones: Record<SceneGenerationHistoryBoundary, HistoryBoundaryTone> = {
  started: 'live',
  candidateCreated: 'live',
  waitingDecision: 'wait',
  waitingReview: 'wait',
  paused: 'muted',
  committed: 'done',
  failed: 'danger',
  cancelled: 'muted'
}

const stageLabels: Record<SceneGenerationRenderStage, string> = {
  readingInput: '读取输入',
  generating: '生成中',
  validating: '校验 / 修正',
  waitingReview: '等待审阅',
  committing: '提交中',
  completed: '已完成',
  failed: '生成失败',
  cancelled: '已取消',
  paused: '已暂停'
}

export function historyBoundaryLabel(boundary: SceneGenerationHistoryBoundary): string {
  return boundaryLabels[boundary]
}

export function historyBoundaryTone(boundary: SceneGenerationHistoryBoundary): HistoryBoundaryTone {
  return boundaryTones[boundary]
}

export function historyStageLabel(stage: SceneGenerationRenderStage): string {
  return stageLabels[stage]
}

export function nextHistoryCursor(page: readonly SceneGenerationHistorySummaryVO[]): string | null {
  return page.at(-1)?.checkpointId ?? null
}

export function historyHasMore(pageLength: number, limit = historyPageSize): boolean {
  return limit > 0 && pageLength === limit
}

export function mergeHistoryPage(
  current: readonly SceneGenerationHistorySummaryVO[],
  page: readonly SceneGenerationHistorySummaryVO[],
  scope: { projectId: string; sceneId: string }
): readonly SceneGenerationHistorySummaryVO[] {
  const seen = new Set(current.map((item) => item.checkpointId))
  const appended: SceneGenerationHistorySummaryVO[] = []
  for (const item of page) {
    if (item.projectId !== scope.projectId || item.sceneId !== scope.sceneId) continue
    if (seen.has(item.checkpointId)) continue
    seen.add(item.checkpointId)
    appended.push(item)
  }
  return appended.length === 0 ? current : [...current, ...appended]
}

export function historyViewStateOf(input: {
  count: number
  loading: boolean
  error: string | null
}): HistoryViewState {
  if (input.count > 0) return 'ready'
  if (input.loading) return 'loading'
  if (input.error !== null) return 'error'
  return 'empty'
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

export function historyClock(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function historyFullTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function historySecondTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function historyFailureReasonLabel(
  reason: SceneGenerationFailureReasonVO | null | undefined
): string | null {
  if (!reason) return null
  const failureClass = failureClassOfLegacyReason(reason)
  if (failureClass) return failureClassTitle(failureClass)
  return null
}

export type HistoryRowView = {
  time: string
  status: string
  tone: HistoryBoundaryTone
  summary: string
}

export type HistoryDetailView = {
  clock: string
  time: string
  summary: string
  boundary: string
  stage: string
  tone: HistoryBoundaryTone
  failureReason: string | null
  readonlyNote: string
}

function isPendingVerification(record: SceneGenerationHistorySummaryVO): boolean {
  return (
    record.boundary === 'failed' &&
    !record.failureReason &&
    pendingVerificationMessages.has(record.message)
  )
}

export function historyRowViewOf(record: SceneGenerationHistorySummaryVO): HistoryRowView {
  const pendingVerification = isPendingVerification(record)
  return {
    time: historyClock(record.createdAt),
    status: pendingVerification
      ? historyPendingVerificationLabel
      : historyBoundaryLabel(record.boundary),
    tone: pendingVerification ? 'muted' : historyBoundaryTone(record.boundary),
    summary: record.message
  }
}

export function historyDetailViewOf(record: SceneGenerationHistorySummaryVO): HistoryDetailView {
  const pendingVerification = isPendingVerification(record)
  return {
    clock: historyClock(record.createdAt),
    time: historyFullTime(record.createdAt),
    summary: record.message,
    boundary: pendingVerification
      ? historyPendingVerificationLabel
      : historyBoundaryLabel(record.boundary),
    stage: pendingVerification ? historyPendingVerificationStage : historyStageLabel(record.stage),
    tone: pendingVerification ? 'muted' : historyBoundaryTone(record.boundary),
    failureReason: historyFailureReasonLabel(record.failureReason),
    readonlyNote: historyReadonlyNote
  }
}

export type ActiveHistoryRowView = {
  status: string
  tone: HistoryBoundaryTone
  message: string
  canCancel: boolean
}

const activeHistoryPhases: ReadonlySet<GenerationPhase> = new Set<GenerationPhase>([
  'preparing',
  'running',
  'waiting',
  'committing',
  'cancelling'
])

const activeHistoryTones: Record<GenerationTone, HistoryBoundaryTone> = {
  ready: 'muted',
  live: 'live',
  wait: 'wait',
  done: 'done',
  danger: 'danger',
  muted: 'muted'
}

export function activeHistoryRowViewOf(
  status: SceneGenerationRenderStatusVO | null | undefined
): ActiveHistoryRowView | null {
  if (!status) return null
  const phase = generationPhaseOf(status)
  if (!activeHistoryPhases.has(phase)) return null
  const pill = statusPillOf(status)
  return {
    status: pill.label,
    tone: activeHistoryTones[pill.tone],
    message: waitingModelNote(status) ?? status.stageMessage,
    canCancel: status.canCancel
  }
}

/** 未完成操作列表的一行；只描述发现结果，不提供隐式恢复。 */
export type UnfinishedOperationRowView = {
  time: string
  status: string
  tone: HistoryBoundaryTone
  message: string
  /** 后端证明可继续无检查点现场；仍要作者显式点击继续。 */
  canResume: boolean
  /** 后端证明写入/提交回执待核对；只提供核对入口。 */
  canVerify: boolean
}

/**
 * 未完成操作不是历史条目：时间只取记录里真实存在的 updatedAt，缺失就如实说明，
 * 不用历史时间或当前时间补造。
 */
export function unfinishedOperationRowViewOf(
  status: SceneGenerationRenderStatusVO
): UnfinishedOperationRowView {
  const pill = statusPillOf(status)
  return {
    time: status.updatedAt ? historyClock(status.updatedAt) : '时间未记录',
    status: pill.label,
    tone: activeHistoryTones[pill.tone],
    message: waitingModelNote(status) ?? status.stageMessage,
    canResume: status.canResumeUnfinished === true,
    canVerify: status.canVerifyResult === true
  }
}
