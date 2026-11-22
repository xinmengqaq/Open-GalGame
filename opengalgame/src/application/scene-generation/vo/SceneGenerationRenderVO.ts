import type {
  SceneGenerationForkOriginVO,
  SceneGenerationRepairSource,
  SceneGenerationRunMode,
  SceneGenerationStateVO
} from './SceneGenerationVO'
import type {
  SceneGenerationCandidatePreviewAuthorization,
  SceneGenerationPublicFailure
} from './SceneGenerationFailureVO'

export type SceneGenerationFailureReasonVO = NonNullable<SceneGenerationPublicFailure['reason']>

export type SceneGenerationRenderFailureVO = SceneGenerationPublicFailure

export type SceneGenerationRecentProgressVO = {
  sequence: number
  createdAt: string
  stage: SceneGenerationRenderStage
  message: string
}

export type SceneGenerationRenderStage =
  | 'readingInput'
  | 'generating'
  | 'validating'
  | 'waitingReview'
  | 'committing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'paused'

export type SceneGenerationInputSummaryDetailsVO = {
  documents?: readonly string[]
  prompts?: readonly string[]
  relations?: readonly string[]
}

export type SceneGenerationInputSummaryVO = {
  canvasId: string
  arrangementVersion: string
  documentCount: number
  assetCount: number
  promptCount: number
  fieldBindingCount: number
  relationCount: number
  confirmedControlCount: number
  details?: SceneGenerationInputSummaryDetailsVO
}

export type SceneGenerationUsageVO = {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  tokenLimit: number | null
  modelCalls?: number
  toolCalls?: number
}

export type SceneGenerationDecisionOptionVO = {
  id: string
  label: string
  description: string
}

export type SceneGenerationRenderReplyKind =
  'select' | 'answers' | 'clarify' | 'accept' | 'revise' | 'discard'

export type SceneGenerationRenderQuestionVO = {
  questionId: string
  prompt: string
  detail?: string
  options: readonly SceneGenerationDecisionOptionVO[]
}

export type SceneGenerationRenderUserMessageVO = {
  kind: 'revise' | 'clarify'
  body: string
  round: number
}

export type SceneGenerationRenderAnsweredQuestionVO = {
  questionId: string
  prompt: string
  optionId: string
  label: string
  description: string
  body?: string
}

export type SceneGenerationRenderInteractionVO = {
  interactionId: string
  checkpointId: string
  kind: 'decision' | 'review' | 'clarification' | 'correction'
  question?: string
  detail?: string
  message: string
  options: readonly SceneGenerationDecisionOptionVO[]
  questions?: readonly SceneGenerationRenderQuestionVO[]
  allowedReplies: readonly SceneGenerationRenderReplyKind[]
  candidateSnapshotId?: string
}

export type SceneGenerationKnownIssueVO = {
  code: string
  message: string
  sequence?: number
  correctable: boolean
  requiresHumanDecision: boolean
  reference?: string
  line?: number
  nearestReference?: string
  nearestAssetName?: string
}

export type SceneGenerationRenderStatusVO = {
  projectId: string
  sceneId: string
  operationId: string
  threadId: string
  branchId: string
  checkpointId?: string
  state: SceneGenerationStateVO
  stage: SceneGenerationRenderStage
  stageMessage: string
  attempt: number
  sequence: number
  updatedAt?: string
  canPause: boolean
  canResume: boolean
  /**
   * 尚未产生检查点的待运行/运行中崩溃现场可显式继续；有活动代次时缺失。
   * 已有检查点的操作只能走原检查点恢复。
   */
  canResumeUnfinished?: boolean
  /** 已提交但登记了清理待处理事实；可显式重试清理，不重开生成。 */
  cleanupPending?: boolean
  /** 已提交且当前没有活动代次，可重试提交后清理。 */
  canRetryCleanup?: boolean
  /**
   * 写入/提交回执不明且没有活动代次，允许作者显式重新核对既有证据。
   * 核对只读取真实回执并按既有门结算，不授予取消、删除或普通续跑。
   */
  canVerifyResult?: boolean
  /**
   * 本记录会阻止同场景开始新的普通生成；仅非终态 generate 为真，
   * 与启动预检共用同一判定，分叉、修复和终态都不占位。
   */
  blocksNewGeneration?: boolean
  canCancel: boolean
  resumeReason?: string
  inputSummary: SceneGenerationInputSummaryVO
  usage: SceneGenerationUsageVO
  activity?: {
    kind: 'model' | 'tool' | 'waitingModel'
    lastActivityAt: string
    lastToolName?: string
    noNewInformationStreak?: number
  }
  recentProgress?: readonly SceneGenerationRecentProgressVO[]
  interaction?: SceneGenerationRenderInteractionVO
  answeredQuestions?: readonly SceneGenerationRenderAnsweredQuestionVO[]
  userMessages?: readonly SceneGenerationRenderUserMessageVO[]
  mode?: SceneGenerationRunMode
  repairSource?: SceneGenerationRepairSource
  candidateSnapshotId?: string
  previewAuthorization?: SceneGenerationCandidatePreviewAuthorization
  knownIssues?: readonly SceneGenerationKnownIssueVO[]
  previewAvailable: boolean
  result?: { commitId: string }
  failure?: SceneGenerationRenderFailureVO
}

export type SceneGenerationRenderProgressEventVO = SceneGenerationRenderStatusVO & {
  message: string
}

export type SceneGenerationTimelineEntryKind =
  'stage' | 'interaction' | 'decision' | 'preview' | 'failure'

export type SceneGenerationTimelineEntryVO = {
  entryId: string
  sequence: number
  createdAt: string
  kind: SceneGenerationTimelineEntryKind
  stage: SceneGenerationRenderStage
  message: string
  interactionId?: string
  candidateSnapshotId?: string
}

export type SceneGenerationCandidatePreviewVO = {
  previewSessionId: string
  candidateSnapshotId: string
  url: string
  expiresAt: string
}

export type SceneGenerationCandidatePreviewEventVO =
  | {
      type: 'ready' | 'stageFailed'
      sequence: number
      projectId: string
      sceneId: string
      previewSessionId: string
      candidateSnapshotId: string
      message?: string
    }
  | {
      type: 'invalidated'
      sequence: number
      projectId: string
      sceneId: string
      previewSessionId: string
      candidateSnapshotId: string
    }

export type SceneGenerationCandidatePreviewListener = (
  event: SceneGenerationCandidatePreviewEventVO
) => void

export type SceneGenerationHistoryBoundary =
  | 'started'
  | 'candidateCreated'
  | 'waitingDecision'
  | 'waitingReview'
  | 'paused'
  | 'committed'
  | 'failed'
  | 'cancelled'

export type SceneGenerationHistorySummaryVO = {
  projectId: string
  sceneId: string
  operationId: string
  threadId: string
  branchId: string
  checkpointId: string
  boundary: SceneGenerationHistoryBoundary
  stage: SceneGenerationRenderStage
  message: string
  createdAt: string
  candidateSnapshotId?: string
  commitId?: string
  failureReason?: SceneGenerationFailureReasonVO
}

/**
 * 按需读取的单条历史详情。分叉资格只由后端从检查点、候选修订与副作用重新证明，
 * 界面不能从列表边界推断。
 */
export type SceneGenerationHistoryDetailVO = SceneGenerationHistorySummaryVO & {
  canFork: boolean
  /** `canFork` 为假时的用户可读原因；可复制时缺失。 */
  forkReason?: string
}

/**
 * 场景级历史的读取结果。`items` 是既有只读历史摘要；`unfinished` 是需要
 * 作者显式处理的操作（无检查点遗留、带检查点的写入/提交待核对，或会阻止
 * 新普通生成的进行中 generate），用独立的 operationId 游标向更早分页。
 * 它们不是历史条目，也不补造检查点。
 */
export type SceneGenerationHistoryPageVO = {
  items: readonly SceneGenerationHistorySummaryVO[]
  unfinished: readonly SceneGenerationRenderStatusVO[]
  /** 还有更早的需要处理操作时为上一页末条 operationId；否则缺失。 */
  unfinishedNextCursor?: string
}

/** 需要作者处理的操作页；游标与历史 checkpointId 游标不共用。 */
export type SceneGenerationUnfinishedPageVO = {
  items: readonly SceneGenerationRenderStatusVO[]
  nextCursor?: string
}

/** 分叉命令返回的必要身份和用户可读来源；不包含需展示的内部标识。 */
export type SceneGenerationForkVO = {
  status: SceneGenerationRenderStatusVO
  source: SceneGenerationForkOriginVO
}

/**
 * 待核对结果的固定结论。页面只展示结论和固定安全文案，不从状态或错误文案
 * 推断写入/提交事实。`stillPending` 包含证据仍不足和只确证“未写/未提交”：
 * 记录、草稿、账本和候选都保持不变，也不因此获得继续或结束权限。
 */
export type SceneGenerationVerificationOutcome =
  | 'candidateWritten'
  | 'committed'
  | 'stillPending'

export type SceneGenerationVerificationResultVO = {
  outcome: SceneGenerationVerificationOutcome
  message: string
  status: SceneGenerationRenderStatusVO
}
