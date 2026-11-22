import type { SceneGenerationReplyDTO } from '../dto/SceneGenerationDTO'
import type { SceneGenerationPublicFailure } from './SceneGenerationFailureVO'

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

export type SceneGenerationRunMode = 'generate' | 'repair' | 'validate'

export interface SceneGenerationRepairSource {
  readonly operationId: string
  readonly threadId: string
  readonly branchId: string
  readonly checkpointId: string
  readonly candidateSnapshotId: string
}

export type SceneGenerationStepVO =
  | 'preparing'
  | 'generating'
  | 'reading'
  | 'validating'
  | 'correcting'
  | 'converting'
  | 'committing'
  | 'rollingBack'

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

/** 分叉来源的安全展示事实；只含摘要与时间，不含操作、线程或检查点标识。 */
export type SceneGenerationForkOriginVO = {
  summary: string
  createdAt?: string
}

/** 分叉建立的新操作和来源展示事实。 */
export type SceneGenerationForkResultVO = SceneGenerationOperationVO & {
  forkFrom: SceneGenerationForkOriginVO
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
  /** 当前构建能否从该检查点继续执行。与 canReply 分开，不用回复资格冒充续跑。 */
  canContinue: boolean
  /** 能否从该检查点复制草稿、输入与候选修订到新分支；与续跑资格分开。 */
  canFork: boolean
  /** 能否在当前等待上提交本阶段已实现的人工回复；旧记录缺失时不视为可回复。 */
  canReply?: boolean
  reason?: string
}

export type SceneGenerationHistoryVO = {
  branches: readonly { branchId: string; sourceBranchId?: string; checkpointId?: string }[]
  checkpoints: readonly SceneGenerationCheckpointVO[]
  nextCursor?: string
}

export type ClearSceneGenerationMemoryVO = { threadId: string; cleared: true }
