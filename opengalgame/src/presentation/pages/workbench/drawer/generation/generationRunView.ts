import type {
  SceneGenerationInputSummaryVO,
  SceneGenerationKnownIssueVO,
  SceneGenerationRenderInteractionVO,
  SceneGenerationRenderStage,
  SceneGenerationRenderStatusVO,
  SceneGenerationUsageVO
} from '@application/scene-generation/vo/SceneGenerationRenderVO'
import type { SceneGenerationStateVO } from '@application/scene-generation/vo/SceneGenerationVO'

import {
  NEXT_ACTIONS,
  failureClassOfLegacyReason,
  failureViewOf,
  generationPhaseOf,
  repairRetryViewOf,
  resumeViewOf,
  type FailureClass,
  type FailureView,
  type GenerationPhase
} from './generationPresentation'

type RenderFailure = NonNullable<SceneGenerationRenderStatusVO['failure']>

/** 公开失败分类。只用于展示筛选，不新增业务事实。 */
export type GenerationRunFailureClass = NonNullable<RenderFailure['failureClass']>

/** 执行记录里的下一步动作。页面动作只映射其中真实可用的部分。 */
export type GenerationRunNextAction = NonNullable<RenderFailure['nextActions']>[number]

/** 候选只读授权。未授权或旧记录为 null。 */
export type GenerationRunPreviewAuthorization = NonNullable<
  SceneGenerationRenderStatusVO['previewAuthorization']
>

/** 运行详情里的安全进度。只来自执行时间线或本次会话已收到的安全文案。 */
export type GenerationRunProgress = {
  sequence: number
  stage: SceneGenerationRenderStage
  message: string
}

export type GenerationRunFailureView = FailureView & {
  failureClass: GenerationRunFailureClass | null
  nextActions: readonly GenerationRunNextAction[]
  /** failed 且执行记录缺少分类或动作的旧记录近似。 */
  legacy: boolean
  /** 当前失败是否可按现有修复重试规则重发；只修复失败且身份完整时为 true。 */
  canRetryRepair: boolean
}

/** 失败分类和下一步动作的统一投影。 */
export type GenerationRunFailureFacts = {
  failureClass: FailureClass | null
  nextActions: readonly GenerationRunNextAction[]
}

export type GenerationRunCandidateView = {
  candidateSnapshotId: string | null
  previewAuthorization: GenerationRunPreviewAuthorization | null
  /** 候选已发布且生成侧校验无阻断问题。 */
  available: boolean
  /** 有真实候选身份且授权允许打开游戏候选。 */
  canOpen: boolean
  /** 失败、取消或待核对后可作为只读上一候选查看。 */
  previous: boolean
  /** 不能查看上一候选时的固定原因；可查看或未到终态时为 null。 */
  previousNote: string | null
}

export type GenerationRunValidationView = {
  knownIssues: readonly SceneGenerationKnownIssueVO[]
  /** 候选已通过生成侧校验；没有候选或存在阻断问题时为 false。 */
  ok: boolean
}

/**
 * 当前生成的单一表现投影。UI 不再自己拼运行状态、失败动作、候选授权和进度；
 * 旧记录也走同一投影，缺字段保持缺失，不补造。
 */
export type GenerationRunView = {
  runState: SceneGenerationStateVO
  phase: GenerationPhase
  stage: SceneGenerationRenderStage
  stageMessage: string
  failure: GenerationRunFailureView | null
  /** 失败分类：新记录直接使用后端字段，旧记录只在有安全 reason 时按桥接表补出。 */
  failureClass: FailureClass | null
  /** 下一步动作：新记录直接使用后端字段，旧记录按失败分类补齐。 */
  nextActions: readonly GenerationRunNextAction[]
  inputSummary: SceneGenerationInputSummaryVO
  /** 当前没有可公开的候选回读账本，保持 null。 */
  readLedger: null
  candidate: GenerationRunCandidateView
  validation: GenerationRunValidationView
  usage: SceneGenerationUsageVO
  activity: NonNullable<SceneGenerationRenderStatusVO['activity']> | null
  interaction: SceneGenerationRenderInteractionVO | null
  progress: readonly GenerationRunProgress[]
  /** 只有真实可续跑的暂停态才允许继续；原因来自现有续跑规则。 */
  resume: { canResume: boolean; reason: string | null }
  /** 只有真实可结束的运行才可取消；待核对中断不冒充可取消。 */
  canCancel: boolean
  /** failed 且执行记录缺少分类或动作的旧记录近似。 */
  legacy: boolean
}

/**
 * 把渲染状态收敛成单一运行视图。
 * @param status 后端安全渲染状态；null 表示还没有当前操作。
 * @param progress 本次会话在内存中已收到的安全进度，仅在状态没有时间线时使用。
 */
export function generationRunViewOf(
  status: SceneGenerationRenderStatusVO | null,
  progress: readonly GenerationRunProgress[] = []
): GenerationRunView | null {
  if (!status) return null
  const phase = generationPhaseOf(status)
  const failure = status.failure ?? null
  const failureFacts = failureFactsOf(failure)
  const resume = resumeViewOf(status)
  return {
    runState: status.state,
    phase,
    stage: status.stage,
    stageMessage: status.stageMessage,
    failure: failureViewFor(status, phase, failure, failureFacts),
    failureClass: failureFacts.failureClass,
    nextActions: failureFacts.nextActions,
    inputSummary: status.inputSummary,
    readLedger: null,
    candidate: candidateViewOf(status),
    validation: {
      knownIssues: status.knownIssues ?? [],
      ok: status.previewAvailable
    },
    usage: status.usage,
    activity: status.activity ?? null,
    interaction: status.interaction ?? null,
    progress: status.recentProgress ?? progress,
    resume,
    // 待核对和候选冲突的中断没有可确认的结束语义，不显示取消；暂停仍可结束本次生成。
    canCancel: status.canCancel && (status.state !== 'interrupted' || status.stage === 'paused'),
    legacy: failure?.legacy === true
  }
}

/**
 * 新记录直接使用后端给出的分类和下一步动作；只有安全 reason 的旧记录
 * 按统一桥接表重做投影，不把旧 reason 当作新的失败决策入口。
 */
export function failureFactsOf(failure: RenderFailure | null): GenerationRunFailureFacts {
  if (!failure) return { failureClass: null, nextActions: [] }
  const failureClass: FailureClass | null =
    failure.failureClass ??
    (failure.reason ? failureClassOfLegacyReason(failure.reason) : undefined) ??
    null
  const nextActions: readonly GenerationRunNextAction[] =
    failure.nextActions && failure.nextActions.length > 0
      ? [...failure.nextActions]
      : failureClass
        ? [...NEXT_ACTIONS[failureClass]]
        : []
  return { failureClass, nextActions }
}

/**
 * 失败视图在已有安全失败文案上增加分类、下一步动作和旧记录近似。
 * 没有失败对象的失败阶段仍给出通用说明，不从本地猜测原因。
 */
function failureViewFor(
  status: SceneGenerationRenderStatusVO,
  phase: GenerationPhase,
  failure: RenderFailure | null,
  failureFacts: GenerationRunFailureFacts
): GenerationRunFailureView | null {
  if (!failure && phase !== 'failed') return null
  return {
    ...failureViewOf(status),
    failureClass: failureFacts.failureClass,
    nextActions: failureFacts.nextActions,
    legacy: failure?.legacy === true,
    canRetryRepair: repairRetryViewOf(status).eligible
  }
}

/** 失败、取消和待核对中断只按后端明确的只读授权查看上一候选。 */
function previousCandidateState(status: SceneGenerationRenderStatusVO): {
  canView: boolean
  note: string | null
} {
  if (!isReadOnlyTerminal(status)) return { canView: false, note: null }
  if (
    status.previewAuthorization === 'readOnly' &&
    status.previewAvailable &&
    status.candidateSnapshotId &&
    status.checkpointId
  ) {
    return { canView: true, note: '只能只读查看，不能接受或修改。' }
  }
  if (
    status.previewAuthorization === 'readOnly' &&
    status.previewAvailable &&
    status.candidateSnapshotId &&
    !status.checkpointId
  ) {
    return { canView: false, note: '上一候选缺少可查看的检查点，暂时不能查看。' }
  }
  if (
    status.previewAuthorization === 'unavailable' ||
    (status.previewAuthorization === 'readOnly' && !status.previewAvailable)
  ) {
    return {
      canView: false,
      note: status.candidateSnapshotId ? '上一候选暂时不可查看，可以按画布重新生成。' : null
    }
  }
  return { canView: false, note: null }
}

/** 失败、取消和待核对中断的只读候选范围；暂停仍走恢复语义。 */
function isReadOnlyTerminal(status: SceneGenerationRenderStatusVO): boolean {
  return (
    status.state === 'failed' ||
    status.state === 'cancelled' ||
    (status.state === 'interrupted' && status.stage !== 'paused')
  )
}

/**
 * 真实候选身份和打开资格。进行中的审阅/修正仍要求交互绑定；
 * 失败、取消和待核对中断只认后端只读授权。
 */
function candidateViewOf(status: SceneGenerationRenderStatusVO): GenerationRunCandidateView {
  const candidateSnapshotId = status.candidateSnapshotId ?? null
  const previous = previousCandidateState(status)
  return {
    candidateSnapshotId,
    previewAuthorization: status.previewAuthorization ?? null,
    available: status.previewAvailable,
    canOpen: candidateCanOpen(status),
    previous: previous.canView,
    previousNote: previous.note
  }
}

function candidateCanOpen(status: SceneGenerationRenderStatusVO): boolean {
  if (!status.previewAvailable) return false
  if (isReadOnlyTerminal(status)) {
    // 与只读候选打开目标一致：只读授权、候选身份和检查点缺一不可；缺检查点不造按钮。
    return (
      status.previewAuthorization === 'readOnly' &&
      Boolean(status.candidateSnapshotId && status.checkpointId)
    )
  }
  const interaction = status.interaction
  const interactionBound =
    interaction !== undefined &&
    (interaction.kind === 'review' || interaction.kind === 'correction')
  if (!interactionBound) return false
  const candidateSnapshotId = interaction.candidateSnapshotId ?? status.candidateSnapshotId
  const checkpointId = interaction.checkpointId ?? status.checkpointId
  if (!candidateSnapshotId || !checkpointId) return false
  // 旧记录或人工写入可能让交互身份与当前状态不一致；不一致时不能按过期身份打开候选。
  if (status.checkpointId !== undefined && interaction.checkpointId !== status.checkpointId) {
    return false
  }
  if (
    status.candidateSnapshotId !== undefined &&
    interaction.candidateSnapshotId !== undefined &&
    interaction.candidateSnapshotId !== status.candidateSnapshotId
  ) {
    return false
  }
  return true
}

export type GenerationRunActionId =
  | 'resume'
  | 'regenerate'
  | 'view-previous-candidate'
  | 'open-summary'
  | 'reload'
  | 'submit-revision'
  | 'return-to-canvas'
  | 'cancel'
  | 'retry-repair'

/**
 * 只返回当前真实可用的页面动作，按主到次排列。
 * 不映射当前公开客户端没有的能力：同操作重试、连接设置检查、operation 级丢弃
 * 和重试提交都不在这里出现；修复重试只用于修复失败。
 */
export function generationRunActionsOf(view: GenerationRunView): readonly GenerationRunActionId[] {
  const actions: GenerationRunActionId[] = []
  if (view.resume.canResume) actions.push('resume')
  if (view.failure?.canRetryRepair === true) actions.push('retry-repair')
  if (
    view.phase === 'waiting' &&
    view.interaction !== null &&
    view.interaction.allowedReplies.includes('revise')
  ) {
    actions.push('submit-revision')
  }
  if (view.candidate.previous) actions.push('view-previous-candidate')
  if (
    view.phase === 'completed' ||
    view.phase === 'cancelled' ||
    (view.phase === 'failed' && view.failure?.unverified !== true)
  ) {
    actions.push('regenerate')
  }
  if (view.nextActions.includes('returnToCanvas')) {
    actions.push('return-to-canvas')
  }
  if (view.phase === 'failed') actions.push('reload')
  if (view.phase === 'failed' || view.phase === 'cancelled') actions.push('open-summary')
  if (view.canCancel) actions.push('cancel')
  return actions
}
