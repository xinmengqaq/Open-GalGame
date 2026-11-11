import type { SceneGenerationStateVO } from './SceneGenerationVO'
import type {
  SceneGenerationCandidatePreviewAuthorization,
  SceneGenerationPublicFailure
} from '../services/impl/SceneGenerationFailureFacts'
import type {
  SceneGenerationRepairSource,
  SceneGenerationRunMode
} from '../models/SceneGenerationExecution'

/** 公开失败原因只取执行记录已有的窄枚举，不新增原因。 */
export type SceneGenerationFailureReasonVO = NonNullable<SceneGenerationPublicFailure['reason']>

/**
 * 公开渲染失败。除原有安全文案外，只增加执行记录已有的失败分类、下一步动作
 * 和旧记录近似标记；不暴露诊断分类、HTTP 状态、原因名或路径。
 */
export type SceneGenerationRenderFailureVO = SceneGenerationPublicFailure & {
  /**
   * failed 且执行记录缺少失败分类或下一步动作时标为旧记录。这是近似标记：
   * 当前记录遇到未能分类的失败也会缺字段，因此只用于展示“旧记录”，不反推版本。
   */
  legacy?: boolean
}

/** 最近安全进度。只取执行记录时间线里的固定安全文案，不含模型原文或路径。 */
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

/**
 * 输入摘要的可读明细。只含文档标题、提示词名称与作用范围、关系名与记录标记，
 * 不含正文、路径或字节；每类最多 12 条，溢出时最后一条为「等 N 项」。
 */
export type SceneGenerationInputSummaryDetailsVO = {
  documents?: readonly string[]
  prompts?: readonly string[]
  relations?: readonly string[]
}

/** 只保留数量、画布身份和已保存编排版本，不含正文、路径或字节。 */
export type SceneGenerationInputSummaryVO = {
  canvasId: string
  arrangementVersion: string
  documentCount: number
  assetCount: number
  promptCount: number
  fieldBindingCount: number
  relationCount: number
  confirmedControlCount: number
  /** 旧记录没有该事实时缺失；有明细的分类才有值。 */
  details?: SceneGenerationInputSummaryDetailsVO
}

/**
 * 当前操作累计 Token。`tokenLimit` 为空才表示没有累计上限。
 * 上下文窗口不是这里的分母，不能用总量除以窗口得到顶部百分比。
 */
export type SceneGenerationUsageVO = {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  tokenLimit: number | null
  /** 已发生的模型调用次数。旧记录缺失时不补造。 */
  modelCalls?: number
  /** 已发生的工具调用次数。旧记录缺失时不补造。 */
  toolCalls?: number
}

/** 创作决策的一项。标题和说明都必须由应用层填入，不能只给不透明 ID。 */
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

/** 已确认的用户消息。正文按文本投影，不含路径、检查点内部或模型原文。 */
export type SceneGenerationRenderUserMessageVO = {
  kind: 'revise' | 'clarify'
  body: string
  round: number
}

/** 已接受的一题决定。只含安全展示文本，不含执行记录或模型原文。 */
export type SceneGenerationRenderAnsweredQuestionVO = {
  questionId: string
  prompt: string
  optionId: string
  label: string
  description: string
  body?: string
}

/** 渲染层可见的活动交互。不含工具参数、模型原文或文件路径。 */
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

/**
 * 生成侧已确认的安全问题。只含固定码、安全说明和素材引用事实，
 * 不含工程路径或模型原文。增强字段为契约前向兼容的内部字段，页面不展示。
 */
export type SceneGenerationKnownIssueVO = {
  code: string
  message: string
  sequence?: number
  correctable: boolean
  requiresHumanDecision: boolean
  /** 候选实际写出的素材引用；仅素材引用问题提供，旧记录可缺省。内部字段，页面不展示。 */
  reference?: string
  /** 候选入口文件中的实际行号（1 起）；仅素材引用问题提供，旧记录可缺省。内部字段，页面不展示。 */
  line?: number
  /** 本次素材清单中与该引用最近似的有效命令引用；仅缺失素材时提供。内部字段，页面不展示。 */
  nearestReference?: string
  /** 最近似引用对应的素材名称；随 nearestReference 提供。内部字段，页面不展示。 */
  nearestAssetName?: string
}

export type SceneGenerationRenderStatusVO = {
  projectId: string
  sceneId: string
  operationId: string
  threadId: string
  branchId: string
  /** 当前执行的检查点。尚未产生检查点的旧记录保持缺失，不从历史摘要补。 */
  checkpointId?: string
  state: SceneGenerationStateVO
  stage: SceneGenerationRenderStage
  stageMessage: string
  attempt: number
  sequence: number
  /** 本次操作记录最后写入时间。旧记录没有该事实时保持缺失，不估算。 */
  updatedAt?: string
  canPause: boolean
  canResume: boolean
  canCancel: boolean
  resumeReason?: string
  inputSummary: SceneGenerationInputSummaryVO
  usage: SceneGenerationUsageVO
  /** 生成进行中的最近活动。终态和旧记录保持缺失。 */
  activity?: {
    kind: 'model' | 'tool' | 'waitingModel'
    lastActivityAt: string
    lastToolName?: string
    noNewInformationStreak?: number
  }
  /** 最近 6 条安全进度。旧记录没有执行时间线时保持缺失。 */
  recentProgress?: readonly SceneGenerationRecentProgressVO[]
  interaction?: SceneGenerationRenderInteractionVO
  answeredQuestions?: readonly SceneGenerationRenderAnsweredQuestionVO[]
  /** 已确认的修改或澄清正文。旧记录没有该事实时保持缺失。 */
  userMessages?: readonly SceneGenerationRenderUserMessageVO[]
  /** 显式运行模式。旧记录缺失时不能从候选存在推断。 */
  mode?: SceneGenerationRunMode
  /** 修复重跑的来源身份。只含稳定身份，不含路径。 */
  repairSource?: SceneGenerationRepairSource
  candidateSnapshotId?: string
  /** 失败或取消后的候选授权。可查看时只读，不恢复接受或修改。 */
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

/** 有限安全时间线。只保留稳定身份和固定文案，不保留内部异常或路径。 */
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

/**
 * 候选舞台事件只绑定固定会话身份。就绪和失败可带安全消息，失效不带。
 * `sequence` 在会话内单调递增，用于补投与实时事件去重。
 */
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

/** 场景级 AI 历史只聚合有意义操作边界，不返回路径或内部差异。 */
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
  /** 失败时执行记录已有的安全原因；旧记录没有该事实时保持缺失。 */
  failureReason?: SceneGenerationFailureReasonVO
  /** failed 且执行记录缺少失败分类或下一步动作时标为旧记录；近似边界同渲染状态。 */
  legacy?: boolean
}
