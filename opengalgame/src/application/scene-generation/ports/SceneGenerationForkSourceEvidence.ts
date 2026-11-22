import type {
  SceneGenerationCheckpoint,
  SceneGenerationExecution
} from '../models/SceneGenerationExecution'

/**
 * 建分叉时从权威来源检查点与不可变修订捕获的历史证据。
 * 字段来自来源检查点和 Git 提交，不是分叉记录的自述；后续重新核对时不读取
 * 来源操作当前的可变检查点/候选。
 */
export interface ForkSourceEvidence {
  readonly version: 1
  /** 证据所属的新分叉操作。 */
  readonly operationId: string
  readonly projectId: string
  readonly sceneId: string
  readonly threadId: string
  /** 来源边界从来源检查点读取，并与分叉记录交叉核对。 */
  readonly sourceOperationId: string
  readonly sourceBranchId: string
  readonly checkpointId: string
  readonly candidateSnapshotId: string
  readonly checkpointKind: ForkSourceCheckpointKind
  /** 捕获时来源检查点完整内容的摘要；证明当时确实读到该边界。 */
  readonly checkpointDigest: string
  /** 捕获时来源输入快照摘要；未更换输入的分叉必须继续匹配。 */
  readonly inputSnapshotDigest: string
  /** 候选修订在捕获时的不可变 Git 事实。 */
  readonly revision: ForkSourceRevisionEvidence
  /** 本文档除自身外内容的摘要，用于识别损坏或被替换的证据。 */
  readonly digest: string
}

export interface ForkSourceRevisionEvidence {
  readonly revisionId: string
  readonly treeId: string
  readonly parentRevisionIds: readonly string[]
}

export type ForkSourceCheckpointKind = 'pi-review' | 'legacy'

export type ForkSourceVerification =
  | { readonly ok: true; readonly evidence: ForkSourceEvidence }
  | { readonly ok: false; readonly reason: string }

/**
 * 分叉来源证据的写入与独立核对。捕获只发生一次；核对失败只返回原因，
 * 由调用方保留现场，不清理工作区或改写候选。
 * 证据与捕获标记均缺失时不自动补证：没有独立事实证明该分叉在捕获机制上线前创建
 * 并选定该来源，旧检查点或持久 fork 指针都不能单独自证。所有缺失/损坏证据均保持
 * 现场待核对，不覆盖、不清理。
 */
export interface SceneGenerationForkSourceEvidence {
  /**
   * 从创建分叉时的权威检查点和不可变修订捕获证据。
   * @throws {AppException} 来源身份、候选或修订不可证明，或已有不一致证据。
   */
  capture(execution: SceneGenerationExecution, checkpoint: SceneGenerationCheckpoint): Promise<void>

  /**
   * 独立核对证据与当前分叉执行；不读取来源操作当前检查点。
   * @param revisionId - 指定时必须正是被证明的父修订。
   */
  verify(execution: SceneGenerationExecution, revisionId?: string): Promise<ForkSourceVerification>
}
