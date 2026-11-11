/* eslint-disable boundaries/element-types --
   场景生成统一状态投影与失败分类是跨层共享纯函数（C-1/B2），表现层只读消费。 */
import type {
  ResumeSceneGenerationDTO,
  RetrySceneGenerationRepairDTO,
  SceneGenerationPolicyDTO,
  SceneGenerationReplyDTO
} from '@application/scene-generation/dto/SceneGenerationDTO'
import {
  isTerminalState,
  phaseOf
} from '@application/scene-generation/mapping/SceneGenerationStateProjection'
import {
  NEXT_ACTIONS,
  failureClassOfLegacyReason,
  type FailureClass
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

/**
 * 跨层边界：表现层只消费应用层的统一状态投影与失败分类纯函数。
 * 这里集中导入并转出，其他表现层文件从本模块取用，不直接依赖 @application。
 */
export { NEXT_ACTIONS, failureClassOfLegacyReason, isTerminalState }
export type { FailureClass }

/**
 * 表现层只提交已批准的修正次数。模型调用、工具调用、时间和 token 不设上限。
 */
export const generationPolicy: SceneGenerationPolicyDTO = {
  maxCorrections: 2
}

/** 当前没有已确认的控制来源，启动时提交空列表，不从画布推测。 */
export const generationConfirmedControls: readonly never[] = []

export const replyBodyLimit = 2000

const countFormatter = new Intl.NumberFormat('zh-CN')

export function formatCount(value: number): string {
  return countFormatter.format(value)
}

export type GenerationActionKind = 'start' | 'reply' | 'pause' | 'resume' | 'cancel' | 'retryRepair'

export type GenerationActionFailure = {
  kind: GenerationActionKind
  message: string
  unverified: boolean
  /** 结构化失败码；未拿到响应时缺省，不按文案猜测。 */
  code?: number
  /** 工程工作区未就绪。抽屉只显示安全文案，不提供重新构建。 */
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

/** 终态判定统一由应用层状态投影给出；表现层不再维护第二份状态语义。 */

export function generationPhaseOf(status: SceneGenerationRenderStatusVO | null): GenerationPhase {
  if (!status) return 'empty'
  // 终态只由权威 state 决定；phase 是投影值，不回写状态。
  if (isTerminalState(status.state)) {
    const projected = phaseOf(status.state)
    if (projected === 'completed' || projected === 'failed' || projected === 'cancelled') {
      return projected
    }
  }
  // 渲染状态不带 step：暂停、提交和旧记录完成阶段只能由展示阶段补齐语义。
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
  /* 提交结果不明时先表达“待核对”，不能先按失败态说成生成失败。 */
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

/** 头部胶囊的临时窗口：pending start 和 start 失败都发生在旧 status 尚未被替换时。 */
export type GenerationHeaderPillInput = {
  pendingStart?: boolean
  startFailure?: GenerationActionFailure | null
}

/**
 * 头部状态胶囊：待新 status 应用前，旧 status 仍是上一轮终态，不能继续用来描述当前操作。
 * - pending start：显示既有「准备中」，与对话区的「正在准备生成…」一致；
 * - start 失败：显示「启动失败」，与对话区错误一致，不叠旧终态。
 * 已有实时状态时仍以真实 status 为准，避免通信恢复后停在临时窗口。
 * 历史记录详情走 generationHistoryPresentation 的只读投影，不经过这里。
 */
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

/** 阶段轨固定六步；`准备` 由 `state=pending` 派生，不是独立后端阶段。 */
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

/**
 * 阶段轨只按展示阶段定位，不读运行状态，也不猜暂停前的阶段。
 * 暂停、失败和取消返回 null；已完成表示六步都走完。
 */
export function stageRailIndex(stage: SceneGenerationRenderStage): number | null {
  if (stage === 'completed') return generationStages.length
  if (stage === 'paused' || stage === 'failed' || stage === 'cancelled') return null
  const index = generationStages.findIndex((item) => (item.key as string) === stage)
  return index === -1 ? null : index
}

/** 只有进行中的等待模型活动才显示等待说明，终态和旧记录不显示。 */
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

/** 进度说明只来自本次会话收到的安全文案，按序号只增不减。 */
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

/** 进度事件和查询结果都走这里；序号更小的迟到响应不覆盖当前状态。 */
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
  /** 没有配置上限时为 null，页面不渲染限额徽标。 */
  limitLabel: string | null
}

/** 上限为空时不生成徽标文案；有上限才显示“上限”。 */
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
  /** 本轮快照的安全明细；只有后端给出该分类明细时才有值。 */
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

/** 启动前只按画布上真实存在的卡片种类计数，不推断背景、立绘或场景目标。 */
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

/** 计数分类对应的安全明细；素材、动画和已确认控制不提供明细。 */
const statusSummaryDetails: Partial<
  Record<StatusSummaryCountKey, keyof SceneGenerationInputSummaryDetailsVO>
> = {
  documentCount: 'documents',
  promptCount: 'prompts',
  relationCount: 'relations'
}

/** 启动后只读本轮快照的安全计数和可用明细，不展示快照外的字段。 */
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

/** 确认页只说明来源类别与数量，不显示画布路径或内部身份。 */
export function inputSourceTextOf(entries: readonly InputSummaryEntry[]): string {
  const visible = entries.filter((entry) => entry.count > 0)
  if (visible.length === 0) return '已保存画布编排'
  return `已保存画布编排 · ${visible.map((entry) => `${entry.label} ${entry.count}`).join(' · ')}`
}

export type StartBlockerInput = {
  saveState: WorkbenchSaveState
  pageBlocked: boolean
  canvasReady: boolean
  active: boolean
  unavailableReason: string | null
}

/** 开始生成前的唯一禁用依据；界面只显示这里返回的原因。 */
export function startBlockedReason(input: StartBlockerInput): string | null {
  if (input.pageBlocked) return '当前工程文件不属于此工作台，不能开始生成。'
  if (!input.canvasReady) return '画布编排还没有读取完成。'
  if (input.unavailableReason) return input.unavailableReason
  if (input.active) return '当前场景已有生成任务，先完成或结束它。'
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
  /** 本次操作最后写入时间；旧记录缺失时为 null，不估算。 */
  recordedAt: string | null
  unverified: boolean
  retryHint: string | null
}

type FailureReason = NonNullable<NonNullable<SceneGenerationRenderStatusVO['failure']>['reason']>

/** 失败分类的用户语言固定标题；新文案只按分类决策，不按旧 reason 分叉。 */
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

/** 旧 reason 文案只作 legacy 兜底；记录能桥接出分类时一律用分类标题。 */
const legacyFailureTitles: Record<FailureReason, string> = {
  noInformationGain: '生成已停止',
  missingCandidateWrite: '生成已停止',
  outputTruncated: '输出被截断',
  missingStructuredResult: '提交结果不可用',
  structuredOutput: '提交结果不可用',
  modelFailure: '模型调用失败',
  modelRejected: '请求被拒绝',
  modelAccess: '鉴权失败',
  contextOverflow: '输入过长',
  correctionsExhausted: '修正次数用尽'
}

export function failureClassTitle(failureClass: GenerationRunFailureClass): string {
  return failureClassTitles[failureClass]
}

/** 失败标题：优先分类；旧记录只有安全 reason 时按统一桥接表取分类标题。 */
function failureTitleOf(failure: NonNullable<SceneGenerationRenderStatusVO['failure']>): string {
  const failureClass =
    failure.failureClass ??
    (failure.reason ? failureClassOfLegacyReason(failure.reason) : undefined)
  if (failureClass) return failureClassTitle(failureClass)
  return (failure.reason && legacyFailureTitles[failure.reason]) || '生成没有完成'
}

const unverifiedRetryHint = '先重新读取任务状态，确认这次生成是否已经提交。'

/** 失败只显示安全文案、故障指纹和操作时间，不显示内部错误码、分类或异常原文。 */
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

/**
 * 只有中断的暂停态才可能续跑；后端允许、身份完整且检查点存在才显示动作。
 * 其余情况明确给出不可续跑原因，不把失败终态说成可恢复。
 */
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

/** 非暂停的中断没有可继续身份；失败区块要用固定文案说明不可续跑。 */
export function interruptionNoteOf(status: SceneGenerationRenderStatusVO): string | null {
  if (status.state !== 'interrupted' || status.stage === 'paused') return null
  return status.resumeReason ?? '这次运行已经中断，当前检查点不可续跑；请重新核对后发起新的生成。'
}

/**
 * 恢复身份只取当前渲染状态。缺检查点、范围不一致，或交互仍绑定另一检查点/候选时不发请求。
 * 调用方不能再从历史摘要补这些字段。
 */
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

export type RepairRetryView = {
  /** 当前失败是否来自修复轮，决定次要按钮说“按画布重新生成”。 */
  isRepair: boolean
  /** 非中断修复失败且修改正文、来源身份都完整时才显示“重试本次修改”。 */
  eligible: boolean
  instruction: string | null
  inputEntries: readonly InputSummaryEntry[]
  candidateAvailable: boolean
  /** 有修复来源但不能重试时的固定原因；首次生成失败保持 null。 */
  blocker: string | null
}

const missingRepairSourceNote = '这次失败没有保留上一候选的来源身份，不能重试本次修改。'
const missingRepairInstructionNote = '这次失败没有可携带的修改正文，只能按画布重新生成。'
const missingRepairCandidateNote = '这次失败没有保留可重试的候选身份，不能重试本次修改。'

/** 只取已确认的修改正文；澄清不是修复正文，不能拿来重试。 */
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

/**
 * 重试本次修改只适用于非中断的修复失败。失败待核对时先核对状态；
 * 来源始终是这次失败操作自身：自身身份缺失时明确阻断，不借用上一候选身份。
 */
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

/**
 * 修复重跑请求只使用渲染状态里已确认的事实：这次失败操作自身的身份、修改正文和当前画布身份。
 * 不读路径、检查点内部或模型原文，也不用上一候选的 `repairSource` 代替本次失败来源。
 */
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
 * 终态气泡可用的页面动作。等待态的“提交修改要求”由生成交互承载，
 * 终态气泡不会渲染等待态，因此不进入终态动作集合。
 */
export type GenerationOutcomeActionId = Exclude<GenerationRunActionId, 'submit-revision'>

/** 动作主次由运行状态和失败分类共同决定。 */
export type GenerationOutcomeSituation = {
  phase: GenerationPhase
  failureClass: GenerationRunFailureClass | null
  unverified: boolean
}

const pausedActionOrder: readonly GenerationOutcomeActionId[] = ['resume', 'cancel']
const interruptedActionOrder: readonly GenerationOutcomeActionId[] = [
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

/**
 * 失败终态按设计主次排列，再补上当前真实可用的“按画布重新生成”。
 * 设计里的“修改要求/减少输入/检查连接”没有对应的公开能力，不能占位；
 * 否则过滤真实动作后动作区会变空，用户失去现有的重新开始生成入口。
 */
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

/**
 * 按设计里的主次顺序排列真实可用动作。传入集合仍必须来自
 * `generationRunActionsOf(view)`，这里只负责筛选和排序，不虚构动作。
 */
export function orderedOutcomeActions(
  situation: GenerationOutcomeSituation,
  available: readonly GenerationRunActionId[]
): readonly GenerationOutcomeActionId[] {
  const allowed = new Set(available)
  return outcomeActionOrderOf(situation).filter((action) => allowed.has(action))
}

/** 动作标签按状态区分，不显示动作 ID 或内部语义。 */
export function outcomeActionLabel(
  action: GenerationOutcomeActionId,
  situation: Pick<GenerationOutcomeSituation, 'phase' | 'failureClass'>
): string {
  switch (action) {
    case 'resume':
      return '继续生成'
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

/** 终态气泡的“下一步”只给用户能理解的方向，不展开后端错误。 */
export function outcomeNextStepOf(input: {
  phase: GenerationPhase
  failureClass: GenerationRunFailureClass | null
  unverified: boolean
  canResume: boolean
  resumeReason: string | null
  interruptionNote: string | null
  /** 已通过真实能力和回调过滤、实际会渲染的动作。 */
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
    return '先核对任务状态，确认这次生成是否已经提交；不要用重新生成掩盖不确定结果。'
  }
  if (input.interruptionNote) return input.interruptionNote
  switch (input.failureClass) {
    case 'modelTransient':
      if (has('regenerate')) return '按画布重新生成会重新读取已保存编排，不沿用上一候选。'
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
  /** 这次审阅的候选是降级产出的：完成说明缺失，服务端不能直接提交。 */
  degraded: boolean
}

const legacySummaryNotice = '完成摘要未生成，请核对创作取舍'
const generatedCandidateNotice = '已生成候选，但这次没有提供完成说明。请先核对候选内容。'
const missingCandidateNotice = '这次没有生成新的候选。请核对失败原因和输入后重新生成。'

// 接受被拦下时的可执行指引：两种拦截都要求用户先给出修改方向，或丢弃后重来。
const degradedAcceptHint = '完成说明缺失，候选不能直接接受。请提出修改，或丢弃候选后重新生成。'
const exhaustedAcceptHint = '自动修正已用尽，候选还有校验问题。请提出修改，或丢弃候选后重新生成。'

/**
 * #19：把历史记录里的内部摘要措辞换成用户语言。已有候选、缺什么、能做什么
 * 分开说明；不出现“创作取舍”，也不宣称候选已经可玩。
 */
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

/** 草稿只对当前交互有效。换节点时清空各题答案，不把旧题答案套到新题。 */
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

/**
 * 审阅交互里接受按钮被拦下的原因。降级候选（完成说明缺失）和带未解决可修正
 * 问题的候选都不能直接提交：两者都要先说明修改方向，或丢弃后重新生成。
 */
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

/** 回复只使用允许的形状，不发送 `selection` 或选项标题。 */
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

/** 主提交按钮文案随交互形状变化，决定、补充和修改不共用一个说法。 */
export function primaryReplyLabel(interaction: SceneGenerationRenderInteractionVO): string {
  if (interaction.questions?.length) return '提交全部回答并继续'
  if (interaction.kind === 'decision') return '提交决定并继续'
  if (interaction.kind === 'clarification') return '提交补充并继续'
  if (interaction.kind === 'correction') return '提交修改并继续'
  return '提交修改并继续'
}

/** 审阅失败后不能继续或接受旧交互，只能重新核对状态。 */
export function interactionIsLive(
  status: SceneGenerationRenderStatusVO | null,
  interactionId: string
): boolean {
  if (!status || isTerminalState(status.state)) return false
  return status.interaction?.interactionId === interactionId && status.state === 'waiting'
}
