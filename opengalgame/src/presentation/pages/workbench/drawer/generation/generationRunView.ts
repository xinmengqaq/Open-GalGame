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

export type GenerationRunFailureClass = NonNullable<RenderFailure['failureClass']>

export type GenerationRunNextAction = NonNullable<RenderFailure['nextActions']>[number]

export type GenerationRunPreviewAuthorization = NonNullable<
  SceneGenerationRenderStatusVO['previewAuthorization']
>

export type GenerationRunProgress = {
  sequence: number
  stage: SceneGenerationRenderStage
  message: string
}

export type GenerationRunFailureView = FailureView & {
  failureClass: GenerationRunFailureClass | null
  nextActions: readonly GenerationRunNextAction[]
  canRetryRepair: boolean
}

export type GenerationRunFailureFacts = {
  failureClass: FailureClass | null
  nextActions: readonly GenerationRunNextAction[]
}

export type GenerationRunCandidateView = {
  candidateSnapshotId: string | null
  previewAuthorization: GenerationRunPreviewAuthorization | null
  available: boolean
  canOpen: boolean
  previous: boolean
  previousNote: string | null
}

export type GenerationRunValidationView = {
  knownIssues: readonly SceneGenerationKnownIssueVO[]
  ok: boolean
}

export type GenerationRunView = {
  runState: SceneGenerationStateVO
  phase: GenerationPhase
  stage: SceneGenerationRenderStage
  stageMessage: string
  failure: GenerationRunFailureView | null
  failureClass: FailureClass | null
  nextActions: readonly GenerationRunNextAction[]
  inputSummary: SceneGenerationInputSummaryVO
  readLedger: null
  candidate: GenerationRunCandidateView
  validation: GenerationRunValidationView
  usage: SceneGenerationUsageVO
  activity: NonNullable<SceneGenerationRenderStatusVO['activity']> | null
  interaction: SceneGenerationRenderInteractionVO | null
  progress: readonly GenerationRunProgress[]
  resume: { canResume: boolean; reason: string | null }
  /** 无检查点的待运行/运行中崩溃现场可显式继续。 */
  canResumeUnfinished: boolean
  /** 已提交但清理未完成，可显式重试清理。 */
  canRetryCleanup: boolean
  /** 写入/提交回执不明且无活动代次，可显式重新核对结果。 */
  canVerifyResult: boolean
  canCancel: boolean
}

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
    canResumeUnfinished: status.canResumeUnfinished === true,
    canRetryCleanup: status.canRetryCleanup === true,
    canVerifyResult: status.canVerifyResult === true,
    canCancel: status.canCancel && (status.state !== 'interrupted' || status.stage === 'paused')
  }
}

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
    canRetryRepair: repairRetryViewOf(status).eligible
  }
}

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

function isReadOnlyTerminal(status: SceneGenerationRenderStatusVO): boolean {
  return (
    status.state === 'failed' ||
    status.state === 'cancelled' ||
    (status.state === 'interrupted' && status.stage !== 'paused')
  )
}

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
  | 'resume-unfinished'
  | 'retry-cleanup'
  | 'verify-result'
  | 'regenerate'
  | 'view-previous-candidate'
  | 'open-summary'
  | 'reload'
  | 'submit-revision'
  | 'return-to-canvas'
  | 'cancel'
  | 'retry-repair'

export function generationRunActionsOf(view: GenerationRunView): readonly GenerationRunActionId[] {
  const actions: GenerationRunActionId[] = []
  if (view.resume.canResume) actions.push('resume')
  if (view.canResumeUnfinished) actions.push('resume-unfinished')
  if (view.canRetryCleanup) actions.push('retry-cleanup')
  if (view.canVerifyResult) actions.push('verify-result')
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
