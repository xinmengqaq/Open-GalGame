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
  SceneGenerationRepairSource,
  SceneGenerationResultVO,
  SceneGenerationRunMode,
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
import type {
  FailureClass,
  SceneGenerationFailureReason
} from '../vo/SceneGenerationFailureVO'
import type { SceneGenerationFailureFact } from './SceneGenerationFailureFacts'

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

export type SceneGenerationInterruptReason =
  | 'paused'
  | 'candidateConflict'
  | 'commitUnknown'
  | 'writeUnknown'
  | 'readInterrupted'

export interface SceneGenerationRepairContext {
  readonly sourceOperationId: string
  readonly sourceThreadId: string
  readonly sourceBranchId: string
  readonly sourceCheckpointId: string
  readonly sourceCandidateSnapshotId: string
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
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly totalTokens?: number
  readonly tokenLimit?: number | null
}

export interface SceneGenerationLiveProgress {
  readonly activity: 'model' | 'tool' | 'waitingModel'
  readonly lastActivityAt: string
  readonly lastToolName?: string
  readonly noNewInformationStreak?: number
}

/**
 * 本操作内已通过生成侧校验并发布的候选修订。
 * 只由宿主在执行记录中追加，用来授权按原检查点/修订打开的只读预览；不是任意 Git 对象目录。
 */
export interface SceneGenerationPublishedCandidate {
  readonly candidateSnapshotId: string
  readonly checkpointId: string
  readonly artifactValidation: SceneValidationReport
}

export interface SceneGenerationExecution extends SceneGenerationOperationVO {
  readonly fingerprint: string
  readonly source: SceneSourceLocation
  readonly inputSnapshot: SceneGenerationInputsDTO
  readonly policy: SceneGenerationPolicyDTO
  readonly reviewCandidate: boolean
  readonly baseline: SceneGenerationBaseline
  readonly state: SceneGenerationStateVO
  readonly step?: SceneGenerationStepVO
  readonly attempt: number
  readonly sequence: number
  readonly budget: SceneGenerationBudget
  readonly live?: SceneGenerationLiveProgress
  readonly createdAt?: string
  readonly updatedAt?: string
  readonly mode?: SceneGenerationRunMode
  readonly repairSource?: SceneGenerationRepairSource
  readonly repairContext?: SceneGenerationRepairContext
  readonly repairInputSnapshotId?: string
  readonly workspace?: SceneGenerationWorkspace
  readonly checkpointId?: string
  readonly candidateSnapshotId?: string
  readonly interaction?: SceneGenerationInteractionVO
  readonly replies: readonly ReplySceneGenerationInteractionDTO[]
  readonly pendingReply?: ReplySceneGenerationInteractionDTO
  /** 分叉来源身份；同时记录来源操作和复制到新分支的不可变修订。 */
  readonly fork?: ReadSceneGenerationCheckpointDTO & {
    readonly sourceOperationId?: string
    readonly candidateSnapshotId?: string
  }
  readonly forkRequest?: ForkSceneGenerationDTO
  readonly result?: SceneGenerationResultVO
  readonly preview?: SceneGenerationPreviewVO
  readonly failure?: SceneGenerationFailureFact
  readonly rollbackCommitId?: string
  readonly workspaceCleanupPending?: boolean
  /**
   * 正式作品已提交，但可提交结果的暂停/恢复边界清理尚未完成。
   * 只用于重试清理，不代表提交失败或允许再次提交。
   */
  readonly pauseBoundaryCleanupPending?: boolean
  readonly requiresCleanup?: boolean
  readonly cancellationRequested?: boolean
  readonly interruptReason?: SceneGenerationInterruptReason
  readonly pauseRequested?: boolean
  readonly artifactValidation?: SceneValidationReport
  /**
   * 本操作按发布顺序记录的候选修订；旧记录缺字段时保持缺失。
   * 当前候选的校验结论仍以 artifactValidation 为准，历史修订只用于只读预览授权。
   */
  readonly publishedCandidates?: readonly SceneGenerationPublishedCandidate[]
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
  readonly summary?: string
  readonly unresolvedIssues?: readonly string[]
}

export interface SceneGenerationWorkflowProgress {
  readonly step?: SceneGenerationStepVO
  /** 需作者决定的等待只能与完整交互一起发布；缺省表示这次进度不建立等待。 */
  readonly interaction?: SceneGenerationInteractionVO
  /** 等待进度与交互、检查点、候选写入同一条执行记录，避免重开后靠猜测补全。 */
  readonly state?: 'waiting'
  readonly attempt: number
  readonly budget: SceneGenerationBudget
  readonly artifactValidation?: SceneValidationReport
  readonly live?: SceneGenerationLiveProgress
  readonly checkpointId?: string
  readonly candidateSnapshotId?: string
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
  readonly signal: AbortSignal
  readonly userAbortSignal: AbortSignal
  readonly activeTimeoutSignal: AbortSignal
  readonly publishProgress: (
    progress: SceneGenerationWorkflowProgress
  ) => Promise<SceneGenerationExecution>
  readonly recordCandidateRevision: (
    revision: SceneGenerationCandidateRevisionRecord
  ) => Promise<SceneGenerationExecution>
  readonly recordFailure: (failure: SceneGenerationFailureFact) => Promise<SceneGenerationExecution>
}

export type SceneGenerationCommitState =
  | { state: 'notCommitted' }
  | { state: 'committed'; commitId: string }
  | { state: 'rollbackRequired'; commitId: string }
  | { state: 'unknown' }
