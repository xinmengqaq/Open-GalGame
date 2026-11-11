import type {
  ForkSceneGenerationDTO,
  ReadSceneGenerationCheckpointDTO,
  ReplySceneGenerationInteractionDTO,
  SceneGenerationInputsDTO,
  SceneGenerationPolicyDTO
} from '../dto/SceneGenerationDTO'
import type {
  SceneGenerationCheckpointVO,
  SceneGenerationInteractionVO,
  SceneGenerationOperationVO,
  SceneGenerationPreviewVO,
  SceneGenerationResultVO,
  SceneGenerationStateVO,
  SceneGenerationStepVO
} from '../vo/SceneGenerationVO'
import type { SceneGenerationTimelineEntryVO } from '../vo/SceneGenerationRenderVO'
import type { SceneSourceLocation } from '../../scenes/models/SceneSourceLocation'
import type { SceneGenerationArtifact } from '@domain/scene-generation/models/SceneGenerationArtifact'
import type { SceneValidationReport } from '@domain/scene-generation/models/SceneValidationReport'
import type {
  SceneBaselineState,
  SceneLockState
} from '@domain/scene-generation/models/SceneGenerationRequest'
import type { FailureClass } from './SceneGenerationRunOutcome'
import type {
  SceneGenerationFailureFact,
  SceneGenerationFailureReason
} from '../services/impl/SceneGenerationFailureFacts'

export interface SceneGenerationBaseline {
  readonly commitId: string
  readonly affectedFiles: readonly { relativePath: string; digest?: string }[]
  readonly lockState: SceneLockState
}

export interface SceneGenerationVersionFacts {
  readonly baselineState: SceneBaselineState
  readonly lockState: SceneLockState
}

export interface SceneGenerationWorkspace {
  readonly workspaceId: string
  readonly rootDirectory: string
  readonly sceneDirectory: string
}

export type SceneGenerationInterruptReason = 'paused' | 'candidateConflict' | 'commitUnknown'

export type SceneGenerationRunMode = 'generate' | 'repair' | 'validate'

/**
 * 非中断修复重跑的来源身份。只保留稳定身份，不保存路径或检查点内部。
 * 旧记录没有该事实时保持缺失。
 */
export interface SceneGenerationRepairSource {
  readonly operationId: string
  readonly threadId: string
  readonly branchId: string
  readonly checkpointId: string
  readonly candidateSnapshotId: string
}

/**
 * 修复重跑可用的来源上下文。只保存受控读取坐标和源事实，不保存候选正文。
 * 旧记录没有该事实时保持缺失，不补造。
 */
export interface SceneGenerationRepairContext {
  readonly sourceOperationId: string
  readonly sourceThreadId: string
  readonly sourceBranchId: string
  readonly sourceCheckpointId: string
  readonly sourceCandidateSnapshotId: string
  /** 源候选在候选工作区内的入口路径；只作受控读取坐标。 */
  readonly candidatePath: string
  readonly instruction: string
  readonly summary: string
  readonly confirmedReplies: readonly {
    readonly kind: 'revise' | 'clarify'
    readonly body: string
  }[]
  readonly unresolvedIssues: readonly string[]
  readonly validationReport?: SceneValidationReport
  readonly failureClass?: FailureClass
  readonly failureReason?: SceneGenerationFailureReason
  readonly failureMessage?: string
}

export interface SceneGenerationBudget {
  readonly correctionsUsed: number
  readonly modelCallsUsed: number
  readonly toolCallsUsed: number
  readonly activeElapsedMs: number
  /** 当前操作累计 Token。旧记录缺失时保持未记录，不估算。 */
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly totalTokens?: number
  /** 空值表示累计预算没有上限，不能用上下文窗口代替。 */
  readonly tokenLimit?: number | null
}

/** 生成进行中的最近活动。旧记录没有该事实时保持缺失。 */
export interface SceneGenerationLiveProgress {
  readonly activity: 'model' | 'tool' | 'waitingModel'
  readonly lastActivityAt: string
  readonly lastToolName?: string
  readonly noNewInformationStreak?: number
}

export interface SceneGenerationExecution extends SceneGenerationOperationVO {
  readonly fingerprint: string
  readonly source: SceneSourceLocation
  readonly inputSnapshot: SceneGenerationInputsDTO
  readonly policy: SceneGenerationPolicyDTO
  readonly reviewCandidate: boolean
  readonly baseline: SceneGenerationBaseline
  readonly state: SceneGenerationStateVO
  /**
   * 当前非终态业务步骤。state 是唯一权威状态；phase 由 state + step 派生。
   * 终态与旧记录可以没有 step。
   */
  readonly step?: SceneGenerationStepVO
  readonly attempt: number
  readonly sequence: number
  readonly budget: SceneGenerationBudget
  /** 生成进行中的最近活动。终态和旧记录保持缺失。 */
  readonly live?: SceneGenerationLiveProgress
  /** 操作首次持久化时间。旧记录没有该事实时保持缺失，不估算。 */
  readonly createdAt?: string
  /** 最近一次持久化时间。旧记录没有该事实时保持缺失，不估算。 */
  readonly updatedAt?: string
  /** 显式运行模式。旧记录缺失时不能从候选存在推断。 */
  readonly mode?: SceneGenerationRunMode
  /** 修复重跑的来源身份。旧记录和普通生成保持缺失。 */
  readonly repairSource?: SceneGenerationRepairSource
  /** 修复重跑的来源上下文。旧记录保持缺失，不补造。 */
  readonly repairContext?: SceneGenerationRepairContext
  /** 已物化到本线程的修复输入修订。不是来源候选，也不能直接送审。 */
  readonly repairInputSnapshotId?: string
  readonly workspace?: SceneGenerationWorkspace
  readonly checkpointId?: string
  readonly candidateSnapshotId?: string
  readonly interaction?: SceneGenerationInteractionVO
  readonly replies: readonly ReplySceneGenerationInteractionDTO[]
  readonly pendingReply?: ReplySceneGenerationInteractionDTO
  readonly fork?: ReadSceneGenerationCheckpointDTO
  readonly forkRequest?: ForkSceneGenerationDTO
  readonly result?: SceneGenerationResultVO
  readonly preview?: SceneGenerationPreviewVO
  readonly failure?: SceneGenerationFailureFact
  readonly rollbackCommitId?: string
  readonly workspaceCleanupPending?: boolean
  readonly requiresCleanup?: boolean
  readonly cancellationRequested?: boolean
  readonly interruptReason?: SceneGenerationInterruptReason
  readonly pauseRequested?: boolean
  readonly artifactValidation?: SceneValidationReport
  readonly timeline?: readonly SceneGenerationTimelineEntryVO[]
  readonly resumeReason?: string
}

export interface SceneGenerationCandidate {
  readonly candidateSnapshotId: string
  readonly artifact: SceneGenerationArtifact
  readonly preview: SceneGenerationPreviewVO
  readonly assetChanges: readonly string[]
}

export interface SceneGenerationCheckpoint {
  readonly view: SceneGenerationCheckpointVO
  readonly execution: SceneGenerationExecution
  readonly candidateSnapshotId?: string
  /** 原始图状态摘要；旧检查点缺失时保持缺失，不用默认文案补。 */
  readonly summary?: string
  /** 原始图状态未解决事项；旧检查点缺失时保持缺失，不补造。 */
  readonly unresolvedIssues?: readonly string[]
}

export interface SceneGenerationWorkflowProgress {
  /**
   * 当前业务步骤。缺省表示工作流已结算的终态进度事件；
   * 终态本身以 state 为权威，进度事件不上报新的 state。
   */
  readonly step?: SceneGenerationStepVO
  readonly attempt: number
  readonly budget: SceneGenerationBudget
  readonly artifactValidation?: SceneValidationReport
  readonly live?: SceneGenerationLiveProgress
  readonly checkpointId?: string
  readonly candidateSnapshotId?: string
  /**
   * 本次操作已经自动重试的次数，只用于退避与观测。
   * 旧进度或旧检查点没有该事实时保持缺失，不据此判定失败。
   */
  readonly retryCount?: number
}

export type SceneGenerationWorkflowOutcome = {
  checkpointId: string
  candidateSnapshotId?: string
  budget: SceneGenerationBudget
} & (
  | { state: 'ready'; candidateSnapshotId: string }
  | { state: 'waiting'; interaction: SceneGenerationInteractionVO }
  | { state: 'interrupted'; interruptReason?: SceneGenerationInterruptReason }
)

export type SceneGenerationCandidateRevisionRecord = {
  readonly candidateSnapshotId: string
}

export interface SceneGenerationRuntime {
  readonly execution: SceneGenerationExecution
  /** 传给图和模型的合并停止信号，同时包含用户取消与活跃超时。 */
  readonly signal: AbortSignal
  /** 只表示用户取消。不能用 signal.aborted 推断原因。 */
  readonly userAbortSignal: AbortSignal
  /** 只表示活跃超时。不能用 signal.aborted 推断原因。 */
  readonly activeTimeoutSignal: AbortSignal
  /**
   * 持久保存进度并返回应用结算后的执行快照；失败和取消后的关联沿用已结算预算。
   * @returns 已持久保存的执行事实，不改变入口快照。
   */
  readonly publishProgress: (
    progress: SceneGenerationWorkflowProgress
  ) => Promise<SceneGenerationExecution>
  /**
   * 只持久化候选修订身份，不发布运行阶段；终态阶段由工作流统一结算发布。
   * @returns 已持久保存的执行事实，不改变入口快照。
   */
  readonly recordCandidateRevision: (
    revision: SceneGenerationCandidateRevisionRecord
  ) => Promise<SceneGenerationExecution>
  /**
   * 只持久化失败事实，不发布终态；终态阶段只在副作用结算完成后发布一次。
   * @returns 已持久保存的执行事实，不改变入口快照。
   */
  readonly recordFailure: (failure: SceneGenerationFailureFact) => Promise<SceneGenerationExecution>
}

export type SceneGenerationCommitState =
  | { state: 'notCommitted' }
  | { state: 'committed'; commitId: string }
  | { state: 'rollbackRequired'; commitId: string }
  | { state: 'unknown' }
