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
  statusPillOf,
  waitingModelNote,
  type GenerationPhase,
  type GenerationTone
} from './generationPresentation'

export type HistoryBoundaryTone = 'live' | 'wait' | 'done' | 'danger' | 'muted'

export type HistoryViewState = 'loading' | 'error' | 'empty' | 'ready'

export const historyPageSize = 20

/** 旧记录缺字段时的唯一标记；只在后端给出 `legacy` 时显示，不反推记录版本。 */
export const historyLegacyLabel = '旧记录'
export const historyLegacyNote = '这条记录缺少部分保存字段，只显示已有事实。'
export const historyReadonlyNote =
  '这里只显示后端保存的操作摘要，不包含完整对话、候选内容或提交结果。'

/** P4-1 对提交结果不明和候选冲突中断只投影 failed 边界与固定安全摘要；这里按原文精确识别。 */
const pendingVerificationMessages: ReadonlySet<string> = new Set([
  '提交结果待核对',
  '候选或基线冲突，需要重新核对'
])

/** 待核对不是失败：用中性状态和等待阶段，不补造失败原因或旧记录标记。 */
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

/**
 * 历史摘要只有旧 reason 字段：先经统一桥接还原失败分类，再按分类取用户语言。
 * 旧 reason 文案只作未识别原因的 legacy 兜底，不进入新失败决策。
 */
const legacyFailureReasonLabels: Record<SceneGenerationFailureReasonVO, string> = {
  noInformationGain: '重复读取没有获得新内容',
  missingCandidateWrite: '收到完成提示后仍未写出候选',
  outputTruncated: '模型输出达到长度上限',
  missingStructuredResult: '模型没有提交结构化结果',
  structuredOutput: '模型输出不符合约定',
  modelFailure: '模型调用失败',
  modelRejected: '模型拒绝了这次请求',
  modelAccess: '模型鉴权失败',
  contextOverflow: '输入超出模型可处理范围',
  correctionsExhausted: '自动修正次数已用尽'
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

/** 后端没有 nextCursor；游标是上一页最后一条记录的真实 checkpointId。 */
export function nextHistoryCursor(page: readonly SceneGenerationHistorySummaryVO[]): string | null {
  return page.at(-1)?.checkpointId ?? null
}

/** 只有满页才可能还有更早的记录，不虚构总数或下一页。 */
export function historyHasMore(pageLength: number, limit = historyPageSize): boolean {
  return limit > 0 && pageLength === limit
}

/** 追加更早的记录，保持已加载顺序，并按检查点去重。 */
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

/** 已加载条目存在时，读取失败只提示并保留列表，不把视图打回空态。 */
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

/** 列表行使用紧凑本地时间；无效值保留原文，不显示 Invalid Date。 */
export function historyClock(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 详情使用完整本地时间。 */
export function historyFullTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 故障指纹旁的操作时间精确到秒；无效值保留原文，不显示 Invalid Date。 */
export function historySecondTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** 失败原因只在后端给出安全码时显示；缺失保持 null，不用“未完成”补造原因。 */
export function historyFailureReasonLabel(
  reason: SceneGenerationFailureReasonVO | null | undefined
): string | null {
  if (!reason) return null
  const failureClass = failureClassOfLegacyReason(reason)
  if (failureClass) return failureClassTitle(failureClass)
  return legacyFailureReasonLabels[reason] ?? null
}

/** 列表行只取时间、状态和摘要；阶段、耗时、候选与重试不属于行内信息。 */
export type HistoryRowView = {
  time: string
  status: string
  tone: HistoryBoundaryTone
  summary: string
}

/** 详情只读视图；失败原因和旧记录标记只来自后端字段，缺失不补造。 */
export type HistoryDetailView = {
  clock: string
  time: string
  summary: string
  boundary: string
  stage: string
  tone: HistoryBoundaryTone
  failureReason: string | null
  legacy: boolean
  legacyNote: string | null
  readonlyNote: string
}

/**
 * 只认 P4-1 投影出的两条固定安全摘要，精确匹配其他文案不算待核对。
 * 有真实失败原因或旧记录标记时仍按失败处理，不让文案覆盖明确事实。
 */
function isPendingVerification(record: SceneGenerationHistorySummaryVO): boolean {
  return (
    record.boundary === 'failed' &&
    !record.failureReason &&
    record.legacy !== true &&
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
  const failureReason = historyFailureReasonLabel(record.failureReason)
  const legacy = record.legacy === true
  return {
    clock: historyClock(record.createdAt),
    time: historyFullTime(record.createdAt),
    summary: record.message,
    boundary: pendingVerification
      ? historyPendingVerificationLabel
      : historyBoundaryLabel(record.boundary),
    stage: pendingVerification ? historyPendingVerificationStage : historyStageLabel(record.stage),
    tone: pendingVerification ? 'muted' : historyBoundaryTone(record.boundary),
    failureReason,
    legacy,
    legacyNote: legacy ? historyLegacyNote : null,
    readonlyNote: historyReadonlyNote
  }
}

/** 进行中行只由运行状态投影；它不是历史记录，也不参与分页和检查点。 */
export type ActiveHistoryRowView = {
  status: string
  tone: HistoryBoundaryTone
  message: string
  canCancel: boolean
}

/** 只有尚未结束的操作进入进行中行；终态和空状态不重复出现在 AI 历史顶部。 */
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

/**
 * 运行状态复用页面现有阶段与等待模型投影文案；历史只读取，不写回状态，
 * 也不要求该操作已有检查点。
 */
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
