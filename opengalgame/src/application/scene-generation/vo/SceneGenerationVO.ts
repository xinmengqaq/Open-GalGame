import type { SceneGenerationReplyDTO } from '../dto/SceneGenerationDTO'
import type { SceneGenerationPublicFailure } from '../services/impl/SceneGenerationFailureFacts'

export type SceneGenerationStateVO =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'committing'
  | 'interrupted'
  | 'cancelling'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

/**
 * 非终态的业务步骤。`state` 是唯一权威运行状态，
 * `phase`/`stage` 只能由 state + step 经应用层派生函数生成，不能单独持久化。
 */
export type SceneGenerationStepVO =
  | 'preparing'
  | 'generating'
  | 'reading'
  | 'validating'
  | 'correcting'
  | 'converting'
  | 'committing'
  | 'rollingBack'

/** 由 state + step 派生的外部阶段值。不再作为持久化事实写入新记录。 */
export type SceneGenerationPhaseVO =
  | 'preparing'
  | 'generating'
  | 'reading'
  | 'validating'
  | 'correcting'
  | 'waiting'
  | 'converting'
  | 'committing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'rollingBack'

export type SceneValidationReportVO = {
  issues: readonly {
    code: string
    message: string
    sequence?: number
    correctable: boolean
    requiresHumanDecision: boolean
  }[]
}

export type SceneGenerationPreviewVO = {
  entryFile: string
  files: readonly string[]
  parserVersion: string
  commandLocations: readonly {
    sequence: number
    filePath: string
    line: number
    engineSentenceIndex: number
  }[]
  assetLocations: readonly { assetId: string; relativePath: string; sequence: number }[]
  validationReport: SceneValidationReportVO
}

export type SceneGenerationQuestionVO = {
  questionId: string
  prompt: string
  detail?: string
  options: readonly { id: string; label: string; description: string }[]
}

export type SceneGenerationInteractionVO = {
  interactionId: string
  checkpointId: string
  kind: 'decision' | 'clarification' | 'correction' | 'review'
  question?: string
  detail?: string
  message: string
  options: readonly { id: string; label: string; description?: string }[]
  questions?: readonly SceneGenerationQuestionVO[]
  allowedReplies: readonly SceneGenerationReplyDTO['kind'][]
  candidateSnapshotId?: string
}
export type SceneGenerationOperationVO = {
  projectId: string
  sceneId: string
  operationId: string
  threadId: string
  branchId: string
}

export type SceneGenerationResultVO = SceneGenerationOperationVO & {
  commitId: string
  preview: SceneGenerationPreviewVO
}

export type SceneGenerationStatusVO = SceneGenerationOperationVO & {
  state: SceneGenerationStateVO
  phase: SceneGenerationPhaseVO
  attempt: number
  sequence: number
  canResume: boolean
  resumeReason?: string
  interaction?: SceneGenerationInteractionVO
  result?: SceneGenerationResultVO
  failure?: SceneGenerationPublicFailure
  rollbackCommitId?: string
  checkpointId?: string
  candidateSnapshotId?: string
}

export type SceneGenerationProgressVO = SceneGenerationStatusVO & { message: string }

export type SceneGenerationReplyReceiptVO = SceneGenerationOperationVO & {
  interactionId: string
  replyId: string
  accepted: true
}

export type SceneGenerationCheckpointVO = SceneGenerationOperationVO & {
  checkpointId: string
  phase: SceneGenerationPhaseVO
  summary: string
  decisions: readonly { interactionId: string; reply: SceneGenerationReplyDTO }[]
  differences: readonly { filePath: string; beforeDigest?: string; afterDigest?: string }[]
  preview?: SceneGenerationPreviewVO
  canView: boolean
  canContinue: boolean
  reason?: string
}

export type SceneGenerationHistoryVO = {
  branches: readonly { branchId: string; sourceBranchId?: string; checkpointId?: string }[]
  checkpoints: readonly SceneGenerationCheckpointVO[]
  nextCursor?: string
}

export type ClearSceneGenerationMemoryVO = { threadId: string; cleared: true }
