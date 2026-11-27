import type {
  ForkSceneGenerationFromHistoryDTO,
  ResumeSceneGenerationDTO,
  RetrySceneGenerationRepairDTO,
  SceneGenerationPolicyDTO,
  SceneGenerationRecoveryScopeDTO,
  SceneGenerationReplyDTO
} from '@application/scene-generation/dto/SceneGenerationDTO'
import {
  isTerminalState,
  phaseOf
} from '@application/scene-generation/mapping/SceneGenerationStateProjection'
import type { FailureClass } from '@application/scene-generation/vo/SceneGenerationFailureVO'
import {
  NEXT_ACTIONS,
  failureClassOfLegacyReason
} from '@application/scene-generation/models/SceneGenerationRunOutcome'
import type {
  SceneGenerationInputSummaryDetailsVO,
  SceneGenerationInputSummaryVO,
  SceneGenerationRenderInteractionVO,
  SceneGenerationRenderReplyKind,
  SceneGenerationRenderStage,
  SceneGenerationRenderStatusVO,
  SceneGenerationRenderUserMessageVO,
  SceneGenerationUsageVO
} from '@application/scene-generation/vo/SceneGenerationRenderVO'
import type {
  SessionCard,
  WorkbenchSaveState
} from '@presentation/features/workbench-session/workbenchSession.types'
import type { GenerationRunActionId, GenerationRunFailureClass } from './generationRunView'

export { NEXT_ACTIONS, failureClassOfLegacyReason, isTerminalState }
export type { FailureClass }

export const generationPolicy: SceneGenerationPolicyDTO = {
  maxCorrections: 2
}

export const generationConfirmedControls: readonly never[] = []

export const replyBodyLimit = 2000

const countFormatter = new Intl.NumberFormat('zh-CN')

export function formatCount(value: number): string {
  return countFormatter.format(value)
}

export type GenerationActionKind =
  | 'start'
  | 'reply'
  | 'pause'
  | 'resume'
  | 'resumeUnfinished'
  | 'retryCleanup'
  | 'verifyResult'
  | 'cancel'
  | 'retryRepair'
  | 'fork'

export type GenerationActionFailure = {
  kind: GenerationActionKind
  message: string
  unverified: boolean
  code?: number
  workspaceNotReady?: boolean
}

export type GenerationTone = 'ready' | 'live' | 'wait' | 'done' | 'danger' | 'muted'

export type GenerationStatusPill = { label: string; tone: GenerationTone }

export type GenerationPhase =
  | 'empty'
  | 'preparing'
  | 'running'
  | 'waiting'
  | 'committing'
  | 'paused'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'

export function generationPhaseOf(status: SceneGenerationRenderStatusVO | null): GenerationPhase {
  if (!status) return 'empty'
  if (isTerminalState(status.state)) {
    const projected = phaseOf(status.state)
    if (projected === 'completed' || projected === 'failed' || projected === 'cancelled') {
      return projected
    }
  }
  if (status.stage === 'paused') return 'paused'
  if (status.stage === 'failed') return 'failed'
  if (status.stage === 'cancelled') return 'cancelled'
  if (status.state === 'cancelling') return 'cancelling'
  if (status.stage === 'committing' || status.state === 'committing') return 'committing'
  if (status.state === 'waiting') return 'waiting'
  if (status.state === 'pending') return 'preparing'
  if (status.stage === 'completed') return 'completed'
  return 'running'
}

export function statusPillOf(status: SceneGenerationRenderStatusVO | null): GenerationStatusPill {
  if (!status) return { label: '准备就绪', tone: 'ready' }
  if (status.failure?.unverified === true) return { label: '结果待核对', tone: 'wait' }
  const interaction = status.interaction
  switch (generationPhaseOf(status)) {
    case 'preparing':
      return { label: '准备中', tone: 'live' }
    case 'running':
      return {
        label:
          status.stage === 'readingInput'
            ? '读取输入'
            : status.stage === 'validating'
              ? '校验 / 修正'
              : status.stage === 'waitingReview'
                ? '等待审阅'
                : '生成中',
        tone: 'live'
      }
    case 'waiting':
      return {
        label:
          interaction?.kind === 'review'
            ? '等待审阅'
            : interaction?.kind === 'decision'
              ? '等待你的决定'
              : interaction?.kind === 'correction'
                ? '等待修改'
                : interaction?.kind === 'clarification'
                  ? '等待补充'
                  : '等待回复',
        tone: 'wait'
      }
    case 'committing':
      return { label: '提交中', tone: 'live' }
    case 'paused':
      return { label: '已暂停', tone: 'muted' }
    case 'cancelling':
      return { label: '正在取消', tone: 'danger' }
    case 'completed':
      return { label: '已提交', tone: 'done' }
    case 'failed':
      return { label: '生成失败', tone: 'danger' }
    case 'cancelled':
      return { label: '已取消', tone: 'muted' }
    default:
      return { label: '准备就绪', tone: 'ready' }
  }
}

export type GenerationHeaderPillInput = {
  pendingStart?: boolean
  startFailure?: GenerationActionFailure | null
}

export function headerStatusPillOf(
  status: SceneGenerationRenderStatusVO | null,
  { pendingStart = false, startFailure = null }: GenerationHeaderPillInput = {}
): GenerationStatusPill {
  const stale = status === null || isTerminalState(status.state)
  if (!stale) return statusPillOf(status)
  if (startFailure !== null) return { label: '启动失败', tone: 'danger' }
  if (pendingStart) return { label: '准备中', tone: 'live' }
  return statusPillOf(status)
}

export type GenerationStageKey =
  'preparing' | 'readingInput' | 'generating' | 'validating' | 'waitingReview' | 'committing'

export const generationStages: readonly { key: GenerationStageKey; label: string }[] = [
  { key: 'preparing', label: '准备' },
  { key: 'readingInput', label: '读取输入' },
  { key: 'generating', label: '生成候选' },
  { key: 'validating', label: '校验 / 修正' },
  { key: 'waitingReview', label: '等待审阅' },
  { key: 'committing', label: '提交' }
]

export function stageRailIndex(stage: SceneGenerationRenderStage): number | null {
  if (stage === 'completed') return generationStages.length
  if (stage === 'paused' || stage === 'failed' || stage === 'cancelled') return null
  const index = generationStages.findIndex((item) => (item.key as string) === stage)
  return index === -1 ? null : index
}

export function waitingModelNote(status: SceneGenerationRenderStatusVO): string | null {
  if (status.activity?.kind !== 'waitingModel' || isTerminalState(status.state)) return null
  return status.stageMessage
}

export type GenerationProgressStep = {
  key: string
  sequence: number
  stage: SceneGenerationRenderStage
  message: string
}

const progressStepLimit = 6

export function appendProgressStep(
  steps: readonly GenerationProgressStep[],
  status: SceneGenerationRenderStatusVO
): readonly GenerationProgressStep[] {
  const last = steps[steps.length - 1]
  if (last && status.sequence <= last.sequence) return steps
  if (last && last.message === status.stageMessage && last.stage === status.stage) return steps
  const next = [
    ...steps,
    {
      key: `${status.operationId}-${status.sequence}`,
      sequence: status.sequence,
      stage: status.stage,
      message: status.stageMessage
    }
  ]
  return next.slice(-progressStepLimit)
}

export function mergeRenderStatus(
  current: SceneGenerationRenderStatusVO | null,
  incoming: SceneGenerationRenderStatusVO
): SceneGenerationRenderStatusVO {
  if (
    current &&
    current.operationId === incoming.operationId &&
    incoming.sequence < current.sequence
  ) {
    return current
  }
  return incoming
}

export type TokenView = {
  input: string
  output: string
  total: string
  limitLabel: string | null
}

export function tokenViewOf(usage: SceneGenerationUsageVO): TokenView {
  return {
    input: formatCount(usage.inputTokens),
    output: formatCount(usage.outputTokens),
    total: formatCount(usage.totalTokens),
    limitLabel: usage.tokenLimit === null ? null : `上限 ${formatCount(usage.tokenLimit)}`
  }
}

export type InputSummaryEntry = {
  key: string
  label: string
  count: number
  details?: readonly string[]
}

const cardKindLabels: readonly { key: SessionCard['kind']; label: string }[] = [
  { key: 'document', label: '文档' },
  { key: 'image', label: '图片' },
  { key: 'audio', label: '音频' },
  { key: 'video', label: '视频' },
  { key: 'prompt', label: '提示词' },
  { key: 'animation', label: '动画' },
  { key: 'effect', label: '特效' }
]

export function countCanvasCards(cards: readonly SessionCard[]): readonly InputSummaryEntry[] {
  return cardKindLabels.map(({ key, label }) => ({
    key,
    label,
    count: cards.filter((card) => card.kind === key).length
  }))
}

type StatusSummaryCountKey =
  | 'documentCount'
  | 'assetCount'
  | 'promptCount'
  | 'fieldBindingCount'
  | 'relationCount'
  | 'confirmedControlCount'

const statusSummaryLabels: readonly { key: StatusSummaryCountKey; label: string }[] = [
  { key: 'documentCount', label: '文档' },
  { key: 'assetCount', label: '素材' },
  { key: 'promptCount', label: '提示词' },
  { key: 'fieldBindingCount', label: '动画 / 特效' },
  { key: 'relationCount', label: '关联' },
  { key: 'confirmedControlCount', label: '已确认控制' }
]

const statusSummaryDetails: Partial<
  Record<StatusSummaryCountKey, keyof SceneGenerationInputSummaryDetailsVO>
> = {
  documentCount: 'documents',
  promptCount: 'prompts',
  relationCount: 'relations'
}

export function countStatusInputs(
  summary: SceneGenerationInputSummaryVO
): readonly InputSummaryEntry[] {
  return statusSummaryLabels.map(({ key, label }) => {
    const detailsKey = statusSummaryDetails[key]
    const details = detailsKey ? summary.details?.[detailsKey] : undefined
    return {
      key,
      label,
      count: summary[key],
      ...(details && details.length > 0 ? { details } : {})
    }
  })
}

export function inputSourceTextOf(entries: readonly InputSummaryEntry[]): string {
  const visible = entries.filter((entry) => entry.count > 0)
  if (visible.length === 0) return '已保存画布编排'
  return `已保存画布编排 · ${visible.map((entry) => `${entry.label} ${entry.count}`).join(' · ')}`
}

export type StartBlockerAction = 'start' | 'repair'

/** 会阻止开始新普通生成的进行中操作；只取应用层投影的 blocksNewGeneration。 */
export type StartBlockingOperation = {
  operationId: string
  /** 安全阶段文案，用于说明真实禁止原因。 */
  stageMessage: string
}

export type StartBlockerInput = {
  saveState: WorkbenchSaveState
  pageBlocked: boolean
  canvasReady: boolean
  /** 当前场景的任务状态还没有读完时不能开始，避免在未知状态上多发一次启动。 */
  statusCheck: StartStatusCheck
  /**
   * 场景内会阻止新普通生成的进行中操作：当前记录优先，其次是已读取的未完成列表。
   * 只有应用层投影为 `blocksNewGeneration` 才非空；列表非空本身不代表阻断。
   */
  blockingOperation: StartBlockingOperation | null
  unavailableReason: string | null
}

/** 场景状态核对事实：首次读取、重载与读取失败都明确阻断提前启动。 */
export type StartStatusCheck = 'checking' | 'ready' | 'failed'

/**
 * 从当前视图和已读取的未完成列表中取唯一的阻断操作。
 * 当前记录覆盖同一 operationId 的旧列表项；分叉、修复和终态都不阻断。
 */
export function startBlockingOperationOf(
  status: SceneGenerationRenderStatusVO | null,
  unfinished: readonly SceneGenerationRenderStatusVO[]
): StartBlockingOperation | null {
  if (status?.blocksNewGeneration === true)
    return { operationId: status.operationId, stageMessage: status.stageMessage }
  for (const candidate of unfinished) {
    if (candidate.operationId === status?.operationId) continue
    if (candidate.blocksNewGeneration === true)
      return { operationId: candidate.operationId, stageMessage: candidate.stageMessage }
  }
  return null
}

/**
 * 已有进行中生成时的真实禁止原因，包含安全阶段文案和去处理已有任务的入口说明。
 * 前半句与后端启动冲突文案保持一致。
 */
export function startConflictBlockedReason(operation: StartBlockingOperation): string {
  return `当前场景已有进行中的生成，先完成或结束它（${operation.stageMessage}）；可在 AI 历史中处理已有任务。`
}

/**
 * 开始生成前的唯一禁用依据；界面只显示这里返回的原因。
 * 修复重跑不占用生成位置，只对 `start` 检查已有生成冲突。
 */
export function startBlockedReason(
  input: StartBlockerInput,
  action: StartBlockerAction = 'start'
): string | null {
  if (input.pageBlocked) return '当前工程文件不属于此工作台，不能开始生成。'
  if (!input.canvasReady) return '画布编排还没有读取完成。'
  if (input.unavailableReason) return input.unavailableReason
  if (input.statusCheck === 'checking')
    return '正在核对当前场景是否已有任务，核对完成前不能开始生成。'
  if (input.statusCheck === 'failed')
    return '当前场景的任务状态没有核对成功，请重新核对后再开始生成。'
  if (action === 'start' && input.blockingOperation !== null)
    return startConflictBlockedReason(input.blockingOperation)
  if (input.saveState === 'saving') return '正在保存画布，完成后才能开始生成。'
  if (input.saveState === 'unverified' || input.saveState === 'committedUnsubmitted')
    return '画布保存结果待核对，先确认保存状态再生成。'
  if (input.saveState === 'failed' || input.saveState === 'unsaved')
    return '画布有未保存的修改，先保存再开始生成。'
  return null
}

export const generationHistoryBlockedReason = '生成进行中，暂不能撤销作品历史'

export type FailureView = {
  title: string
  message: string
  reference: string | null
  recordedAt: string | null
  unverified: boolean
  retryHint: string | null
}

const failureClassTitles: Record<GenerationRunFailureClass, string> = {
  inputInvalid: '输入无效',
  blocked: '生成无法继续',
  modelTransient: '模型暂时不可用',
  modelAuth: '连接或权限需要检查',
  modelRejected: '要求无法继续',
  contextOverflow: '输入过多',
  outputContract: '输出不完整',
  noProgress: '没有进展',
  correctionsExhausted: '自动修正次数已用尽',
  internal: '内部错误'
}

export function failureClassTitle(failureClass: GenerationRunFailureClass): string {
  return failureClassTitles[failureClass]
}

function failureTitleOf(failure: NonNullable<SceneGenerationRenderStatusVO['failure']>): string {
  const failureClass =
    failure.failureClass ??
    (failure.reason ? failureClassOfLegacyReason(failure.reason) : undefined)
  if (failureClass) return failureClassTitle(failureClass)
  return '生成没有完成'
}

const unverifiedRetryHint = '先重新读取任务状态，确认这次生成是否已经提交。'

export function failureViewOf(status: SceneGenerationRenderStatusVO): FailureView {
  const failure = status.failure
  const recordedAt = status.updatedAt ?? null
  if (!failure) {
    return {
      title: '生成没有完成',
      message: status.stageMessage,
      reference: null,
      recordedAt,
      unverified: false,
      retryHint: null
    }
  }
  const reference = failure.reference ?? null
  if (failure.unverified === true) {
    return {
      title: '结果待核对',
      message: failure.message,
      reference,
      recordedAt,
      unverified: true,
      retryHint: unverifiedRetryHint
    }
  }
  const title = failureTitleOf(failure)
  return {
    title,
    message: failure.message,
    reference,
    recordedAt,
    unverified: false,
    retryHint: null
  }
}

export function resumeViewOf(status: SceneGenerationRenderStatusVO): {
  canResume: boolean
  reason: string | null
} {
  if (status.stage !== 'paused') {
    return { canResume: false, reason: null }
  }
  if (status.state !== 'interrupted') {
    return { canResume: false, reason: '这次运行不是可继续的暂停状态，本次生成不可续跑。' }
  }
  if (!status.canResume) {
    return {
      canResume: false,
      reason: status.resumeReason ?? '当前检查点不能继续，本次生成不可续跑。'
    }
  }
  if (!status.checkpointId) {
    return { canResume: false, reason: '当前任务没有可继续的检查点，本次生成不可续跑。' }
  }
  return { canResume: true, reason: null }
}

export function interruptionNoteOf(status: SceneGenerationRenderStatusVO): string | null {
  if (status.state !== 'interrupted' || status.stage === 'paused') return null
  return status.resumeReason ?? '这次运行已经中断，当前检查点不可续跑；请重新核对后发起新的生成。'
}

export function resumeRequestOf(
  status: SceneGenerationRenderStatusVO | null,
  scope: { projectId: string; sceneId: string }
): ResumeSceneGenerationDTO | null {
  if (!status?.checkpointId) return null
  if (status.state !== 'interrupted' || status.stage !== 'paused') return null
  if (status.projectId !== scope.projectId || status.sceneId !== scope.sceneId) return null
  const interaction = status.interaction
  if (interaction && interaction.checkpointId !== status.checkpointId) return null
  if (
    interaction?.candidateSnapshotId !== undefined &&
    interaction.candidateSnapshotId !== status.candidateSnapshotId
  ) {
    return null
  }
  return {
    projectId: status.projectId,
    sceneId: status.sceneId,
    operationId: status.operationId,
    threadId: status.threadId,
    branchId: status.branchId,
    checkpointId: status.checkpointId,
    ...(status.candidateSnapshotId ? { candidateSnapshotId: status.candidateSnapshotId } : {})
  }
}

/**
 * 无检查点崩溃现场只取当前状态上的操作、线程和分支身份；已经有检查点、
 * 仍有活动代次或不是待运行/运行中的状态不发请求。普通读取不会触发。
 */
export function unfinishedResumeRequestOf(
  status: SceneGenerationRenderStatusVO | null,
  scope: { projectId: string; sceneId: string }
): SceneGenerationRecoveryScopeDTO | null {
  if (!status?.canResumeUnfinished) return null
  if (status.checkpointId !== undefined) return null
  if (status.state !== 'pending' && status.state !== 'running') return null
  if (status.projectId !== scope.projectId || status.sceneId !== scope.sceneId) return null
  return {
    projectId: status.projectId,
    sceneId: status.sceneId,
    operationId: status.operationId,
    threadId: status.threadId,
    branchId: status.branchId
  }
}

/** 提交后清理只认已提交且仍有待清理事实的状态，不携带检查点或候选。 */
export function cleanupRetryRequestOf(
  status: SceneGenerationRenderStatusVO | null,
  scope: { projectId: string; sceneId: string }
): SceneGenerationRecoveryScopeDTO | null {
  if (!status?.canRetryCleanup || status.cleanupPending !== true) return null
  if (status.state !== 'succeeded') return null
  if (status.projectId !== scope.projectId || status.sceneId !== scope.sceneId) return null
  return {
    projectId: status.projectId,
    sceneId: status.sceneId,
    operationId: status.operationId,
    threadId: status.threadId,
    branchId: status.branchId
  }
}

/**
 * 待核对现场只按状态上的五元身份发核对请求；后端 `canVerifyResult` 已保证
 * 无活动代次且中断类型是写入/提交待核对。页面不自行推断证据或结算结果。
 */
export function unknownVerificationRequestOf(
  status: SceneGenerationRenderStatusVO | null,
  scope: { projectId: string; sceneId: string }
): SceneGenerationRecoveryScopeDTO | null {
  if (!status?.canVerifyResult) return null
  if (status.state !== 'interrupted') return null
  if (status.projectId !== scope.projectId || status.sceneId !== scope.sceneId) return null
  return {
    projectId: status.projectId,
    sceneId: status.sceneId,
    operationId: status.operationId,
    threadId: status.threadId,
    branchId: status.branchId
  }
}

export type RepairRetryView = {
  isRepair: boolean
  eligible: boolean
  instruction: string | null
  inputEntries: readonly InputSummaryEntry[]
  candidateAvailable: boolean
  blocker: string | null
}

const missingRepairSourceNote = '这次失败没有保留上一候选的来源身份，不能重试本次修改。'
const missingRepairInstructionNote = '这次失败没有可携带的修改正文，只能按画布重新生成。'
const missingRepairCandidateNote = '这次失败没有保留可重试的候选身份，不能重试本次修改。'

export function repairInstructionOf(status: SceneGenerationRenderStatusVO): string | null {
  const messages = status.userMessages ?? []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.kind !== 'revise') continue
    const body = message.body.trim()
    if (body.length > 0) return body.slice(0, replyBodyLimit)
  }
  return null
}

export function repairRetryViewOf(status: SceneGenerationRenderStatusVO): RepairRetryView {
  const empty: RepairRetryView = {
    isRepair: false,
    eligible: false,
    instruction: null,
    inputEntries: [],
    candidateAvailable: false,
    blocker: null
  }
  if (status.state !== 'failed') return empty
  const repair = status.mode === 'repair' || status.repairSource !== undefined
  if (!repair) return empty
  const repairEmpty: RepairRetryView = { ...empty, isRepair: true }
  const instruction = repairInstructionOf(status)
  const inputEntries = countStatusInputs(status.inputSummary)
  if (status.failure?.unverified === true) {
    return { ...repairEmpty, instruction, inputEntries, blocker: unverifiedRetryHint }
  }
  if (!instruction) {
    return {
      ...repairEmpty,
      inputEntries,
      candidateAvailable: true,
      blocker: missingRepairInstructionNote
    }
  }
  if (!status.operationId || !status.threadId || !status.branchId) {
    return {
      ...repairEmpty,
      instruction,
      inputEntries,
      candidateAvailable: true,
      blocker: missingRepairSourceNote
    }
  }
  if (!status.checkpointId || !status.candidateSnapshotId) {
    return {
      ...repairEmpty,
      instruction,
      inputEntries,
      candidateAvailable: true,
      blocker: missingRepairCandidateNote
    }
  }
  return {
    isRepair: true,
    eligible: true,
    instruction,
    inputEntries,
    candidateAvailable: true,
    blocker: null
  }
}

export function retryRepairRequestOf(
  status: SceneGenerationRenderStatusVO | null,
  scope: { projectId: string; sceneId: string }
): RetrySceneGenerationRepairDTO | null {
  if (!status) return null
  if (status.projectId !== scope.projectId || status.sceneId !== scope.sceneId) return null
  const view = repairRetryViewOf(status)
  if (!view.eligible || !view.instruction) return null
  if (!status.checkpointId || !status.candidateSnapshotId) return null
  return {
    projectId: status.projectId,
    sceneId: status.sceneId,
    canvasId: status.inputSummary.canvasId,
    confirmedControls: generationConfirmedControls,
    policy: generationPolicy,
    repair: {
      sourceOperationId: status.operationId,
      sourceThreadId: status.threadId,
      sourceBranchId: status.branchId,
      sourceCheckpointId: status.checkpointId,
      candidateSnapshotId: status.candidateSnapshotId,
      instruction: view.instruction
    }
  }
}

/**
 * 分叉请求只使用历史记录已持久化的来源身份和当前场景范围。
 * 不在表现层判断 canFork；资格、候选与副作用由后端重新证明。
 */
export type HistoryForkSource = {
  projectId: string
  sceneId: string
  threadId: string
  branchId: string
  checkpointId: string
}

export function forkRequestOf(
  source: HistoryForkSource,
  scope: { projectId: string; sceneId: string }
): ForkSceneGenerationFromHistoryDTO | null {
  if (source.projectId !== scope.projectId || source.sceneId !== scope.sceneId) return null
  if (!source.threadId || !source.branchId || !source.checkpointId) return null
  return {
    projectId: scope.projectId,
    sceneId: scope.sceneId,
    threadId: source.threadId,
    branchId: source.branchId,
    checkpointId: source.checkpointId,
    policy: generationPolicy
  }
}

export type GenerationOutcomeActionId = Exclude<GenerationRunActionId, 'submit-revision'>

export type GenerationOutcomeSituation = {
  phase: GenerationPhase
  failureClass: GenerationRunFailureClass | null
  unverified: boolean
}

const pausedActionOrder: readonly GenerationOutcomeActionId[] = ['resume', 'cancel']
const interruptedActionOrder: readonly GenerationOutcomeActionId[] = [
  'verify-result',
  'reload',
  'view-previous-candidate',
  'cancel'
]
const cancelledActionOrder: readonly GenerationOutcomeActionId[] = [
  'view-previous-candidate',
  'regenerate',
  'open-summary'
]
const blockedActionOrder: readonly GenerationOutcomeActionId[] = [
  'return-to-canvas',
  'open-summary',
  'regenerate'
]
const genericFailureActionOrder: readonly GenerationOutcomeActionId[] = [
  'reload',
  'view-previous-candidate',
  'regenerate',
  'open-summary'
]

const failureActionOrders: Partial<
  Record<GenerationRunFailureClass, readonly GenerationOutcomeActionId[]>
> = {
  modelTransient: ['regenerate', 'view-previous-candidate'],
  modelAuth: ['reload', 'open-summary', 'regenerate'],
  modelRejected: ['open-summary', 'regenerate'],
  contextOverflow: ['open-summary', 'regenerate'],
  outputContract: ['view-previous-candidate', 'regenerate'],
  noProgress: ['retry-repair', 'view-previous-candidate', 'regenerate'],
  blocked: blockedActionOrder,
  correctionsExhausted: blockedActionOrder,
  inputInvalid: ['return-to-canvas', 'open-summary', 'regenerate'],
  internal: ['reload', 'open-summary', 'regenerate']
}

function outcomeActionOrderOf(
  situation: GenerationOutcomeSituation
): readonly GenerationOutcomeActionId[] {
  if (situation.phase === 'paused') return pausedActionOrder
  if (situation.phase === 'cancelled') return cancelledActionOrder
  if (situation.unverified) return interruptedActionOrder
  if (situation.failureClass) {
    return failureActionOrders[situation.failureClass] ?? genericFailureActionOrder
  }
  return genericFailureActionOrder
}

export function orderedOutcomeActions(
  situation: GenerationOutcomeSituation,
  available: readonly GenerationRunActionId[]
): readonly GenerationOutcomeActionId[] {
  const allowed = new Set(available)
  return outcomeActionOrderOf(situation).filter((action) => allowed.has(action))
}

export function outcomeActionLabel(
  action: GenerationOutcomeActionId,
  situation: Pick<GenerationOutcomeSituation, 'phase' | 'failureClass'>
): string {
  switch (action) {
    case 'resume':
      return '继续生成'
    case 'resume-unfinished':
      return '继续未完成的生成'
    case 'retry-cleanup':
      return '重试清理'
    case 'verify-result':
      return '核对结果'
    case 'retry-repair':
      return '重试本次修改'
    case 'view-previous-candidate':
      return '查看上一候选'
    case 'regenerate':
      return situation.phase === 'cancelled' ? '重新生成' : '按画布重新生成'
    case 'return-to-canvas':
      return '返回画布'
    case 'reload':
      return situation.failureClass === 'modelAuth' ? '重新核对任务状态' : '核对任务状态'
    case 'open-summary':
      return '打开输入摘要'
    case 'cancel':
      return '结束本次生成'
  }
}

export function outcomeNextStepOf(input: {
  phase: GenerationPhase
  failureClass: GenerationRunFailureClass | null
  unverified: boolean
  canResume: boolean
  resumeReason: string | null
  interruptionNote: string | null
  actions: readonly GenerationRunActionId[]
}): string | null {
  const has = (action: GenerationOutcomeActionId): boolean => input.actions.includes(action)
  if (input.phase === 'paused') {
    if (input.canResume) return '继续会沿用原任务、线程和检查点，不新建第二套记忆。'
    return input.resumeReason ?? '本次生成不可续跑；结束本次生成后，可以按画布开始新的生成。'
  }
  if (input.phase === 'cancelled') {
    return '已取消，不会自动继续或重试；已保存的画布和输入不会回滚。'
  }
  if (input.phase !== 'failed') return null
  if (input.unverified) {
    return '核对结果会重新读取真实写入/提交回执；证据不足时保持待核对，不改动候选、工作区或账本。'
  }
  if (input.interruptionNote) return input.interruptionNote
  switch (input.failureClass) {
    case 'modelTransient':
      if (has('regenerate')) return '重试会读取当前已保存的画布，不沿用上一候选。'
      return has('reload') ? '先核对任务状态，确认这次生成的终态。' : null
    case 'modelAuth':
      if (has('reload')) return '先重新核对任务状态，再确认这一轮的输入。'
      if (has('open-summary')) return '打开输入摘要核对这一轮的材料，再决定是否重新生成。'
      return has('regenerate') ? '可以按画布重新生成；不会沿用旧指令或上一候选。' : null
    case 'modelRejected':
      if (has('open-summary')) return '打开输入摘要核对这一轮的材料，再决定是否按画布重新生成。'
      return has('regenerate') ? '按画布重新生成不会沿用旧指令和上一候选。' : null
    case 'contextOverflow':
      if (has('open-summary')) return '打开输入摘要核对这一轮的材料；也可以按画布重新生成。'
      return has('regenerate') ? '按画布重新生成不会沿用旧指令和上一候选。' : null
    case 'outputContract':
      if (has('view-previous-candidate')) {
        return '候选仍可只读查看；确认后再决定是否按画布重新生成。'
      }
      return has('regenerate') ? '按画布重新生成会重新读取已保存编排。' : null
    case 'noProgress':
      if (has('retry-repair') && has('regenerate')) {
        return '重试本次修改会携带这次修改要求；按画布重新生成不沿用旧指令和上一候选。'
      }
      if (has('retry-repair')) return '重试本次修改会携带这次修改要求。'
      return has('regenerate') ? '按画布重新生成会重新读取已保存编排。' : null
    case 'blocked':
    case 'correctionsExhausted': {
      const parts: string[] = []
      if (has('return-to-canvas')) parts.push('返回画布可以先调整编排。')
      if (parts.length === 0 && has('regenerate')) {
        parts.push('按画布重新生成会重新读取已保存编排，不沿用旧指令和上一候选。')
      }
      return parts.length === 0 ? null : parts.join('')
    }
    case 'inputInvalid':
      if (has('return-to-canvas'))
        return '先返回画布核对已保存编排，或打开输入摘要确认这一轮的材料。'
      if (has('open-summary')) return '先打开输入摘要确认这一轮的材料，再决定是否按画布重新生成。'
      return has('regenerate') ? '按画布重新生成会重新读取已保存编排。' : null
    default:
      if (has('reload') && has('regenerate')) return '可以核对任务状态，或按画布重新生成。'
      if (has('reload')) return '先核对任务状态，确认这次生成的终态。'
      return has('regenerate') ? '按画布重新生成会重新读取已保存编排。' : null
  }
}

export function userMessageLabelOf(message: SceneGenerationRenderUserMessageVO): string {
  return message.kind === 'revise'
    ? `第 ${message.round} 轮修改要求`
    : `第 ${message.round} 轮补充说明`
}

export type ReviewNoticeView = {
  lead: string
  notice: string | null
  issues: readonly string[]
  degraded: boolean
}

const legacySummaryNotice = '完成摘要未生成，请核对创作取舍'
const generatedCandidateNotice = '已生成候选，但这次没有提供完成说明。请先核对候选内容。'
const missingCandidateNotice = '这次没有生成新的候选。请核对失败原因和输入后重新生成。'

const degradedAcceptHint = '完成说明缺失，候选不能直接接受。请提出修改，或丢弃候选后重新生成。'
const exhaustedAcceptHint = '自动修正已用尽，候选还有校验问题。请提出修改，或丢弃候选后重新生成。'

export function reviewNoticeOf(
  status: SceneGenerationRenderStatusVO,
  interaction: SceneGenerationRenderInteractionVO
): ReviewNoticeView {
  const lines = interaction.message
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const candidate = interaction.candidateSnapshotId ?? status.candidateSnapshotId
  let lead = lines[0] ?? '请审阅当前候选'
  let rest = lines.slice(1)
  let notice: string | null = null
  let degraded = false
  if (lead === legacySummaryNotice) {
    notice = candidate ? generatedCandidateNotice : missingCandidateNotice
    lead = '请审阅当前候选'
    rest = []
    degraded = true
  }
  const issues: string[] = []
  for (const line of rest) {
    if (line === legacySummaryNotice) {
      notice = candidate ? generatedCandidateNotice : missingCandidateNotice
      degraded = true
      continue
    }
    issues.push(line)
  }
  return { lead, notice, issues, degraded }
}

export type GenerationQuestionDraft = {
  optionId: string | null
  body: string
}

export type GenerationDraft = {
  interactionId: string
  optionId: string | null
  body: string
  answers: Readonly<Record<string, GenerationQuestionDraft>>
}

export const emptyDraft: GenerationDraft = {
  interactionId: '',
  optionId: null,
  body: '',
  answers: {}
}

export function effectiveDraft(
  interaction: SceneGenerationRenderInteractionVO | undefined,
  draft: GenerationDraft
): GenerationDraft {
  if (!interaction) return emptyDraft
  return draft.interactionId === interaction.interactionId
    ? draft
    : { interactionId: interaction.interactionId, optionId: null, body: '', answers: {} }
}

function allows(
  interaction: SceneGenerationRenderInteractionVO,
  kind: SceneGenerationRenderReplyKind
): boolean {
  return interaction.allowedReplies.includes(kind)
}

export function canSelectOption(interaction: SceneGenerationRenderInteractionVO): boolean {
  return allows(interaction, 'select') && interaction.options.length > 0
}

export function canSendBody(interaction: SceneGenerationRenderInteractionVO): boolean {
  return (
    allows(interaction, 'clarify') ||
    allows(interaction, 'revise') ||
    (allows(interaction, 'select') && interaction.options.length > 0)
  )
}

export function acceptBlockedReasonOf(
  status: SceneGenerationRenderStatusVO,
  interaction: SceneGenerationRenderInteractionVO
): string | null {
  if (interaction.kind !== 'review') return null
  if (reviewNoticeOf(status, interaction).degraded) return degradedAcceptHint
  const unresolvedCorrectable = (status.knownIssues ?? []).some(
    (issue) => issue.correctable && !issue.requiresHumanDecision
  )
  return status.previewAvailable === false && unresolvedCorrectable ? exhaustedAcceptHint : null
}

export function canAccept(
  status: SceneGenerationRenderStatusVO,
  interaction: SceneGenerationRenderInteractionVO
): boolean {
  return (
    interaction.kind === 'review' &&
    allows(interaction, 'accept') &&
    acceptBlockedReasonOf(status, interaction) === null
  )
}

export function canDiscard(interaction: SceneGenerationRenderInteractionVO): boolean {
  return allows(interaction, 'discard')
}

export function canRevise(interaction: SceneGenerationRenderInteractionVO): boolean {
  return allows(interaction, 'revise')
}

export function trimReplyBody(body: string): string {
  return body.slice(0, replyBodyLimit).trim()
}

export function buildPrimaryReply(
  interaction: SceneGenerationRenderInteractionVO,
  draft: GenerationDraft
): SceneGenerationReplyDTO | null {
  const questions = interaction.questions
  if (questions?.length) {
    if (!allows(interaction, 'answers')) return null
    const answers = questions.flatMap((question) => {
      const answer = draft.answers[question.questionId]
      const optionId = question.options.find((option) => option.id === answer?.optionId)?.id
      if (!optionId) return []
      const body = trimReplyBody(answer?.body ?? '')
      return [
        {
          questionId: question.questionId,
          optionId,
          ...(body.length > 0 ? { body } : {})
        }
      ]
    })
    return answers.length === questions.length ? { kind: 'answers', answers } : null
  }

  const body = trimReplyBody(draft.body)
  const optionId =
    canSelectOption(interaction) && draft.optionId
      ? interaction.options.find((option) => option.id === draft.optionId)?.id
      : undefined

  if (interaction.kind === 'decision') {
    if (!optionId) return null
    return body.length > 0 ? { kind: 'select', optionId, body } : { kind: 'select', optionId }
  }

  if (interaction.kind === 'clarification') {
    if (optionId)
      return body.length > 0 ? { kind: 'select', optionId, body } : { kind: 'select', optionId }
    if (!allows(interaction, 'clarify')) return null
    return body.length > 0 ? { kind: 'clarify', body } : null
  }

  if (!allows(interaction, 'revise')) return null
  return body.length > 0 ? { kind: 'revise', body } : null
}

export function primaryReplyLabel(interaction: SceneGenerationRenderInteractionVO): string {
  if (interaction.questions?.length) return '提交全部回答并继续'
  if (interaction.kind === 'decision') return '提交决定并继续'
  if (interaction.kind === 'clarification') return '提交补充并继续'
  if (interaction.kind === 'correction') return '提交修改并继续'
  return '提交修改并继续'
}

export function interactionIsLive(
  status: SceneGenerationRenderStatusVO | null,
  interactionId: string
): boolean {
  if (!status || isTerminalState(status.state)) return false
  return status.interaction?.interactionId === interactionId && status.state === 'waiting'
}
