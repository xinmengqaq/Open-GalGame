import type { SceneGenerationExecution } from '../models/SceneGenerationExecution'

/**
 * 候选写入恢复结论。调用方只按结论处理，不从错误文案推断写入资格。
 */
export type SceneCandidateWriteRecoveryResult =
  | { readonly outcome: 'notApplicable' }
  | {
      readonly outcome: 'proven'
      readonly candidateSnapshotId: string
      /** 本次是否为原 started 记录补写了唯一的 completed。 */
      readonly settled: boolean
      /** 证明的是写后读取边界；进入运行时应保留 reading 阶段。 */
      readonly carryReadingStage: boolean
      /** 原检查点不再指向本次证明的候选；继续前必须按新候选重新判定。 */
      readonly checkpointSuperseded: boolean
    }
  | {
      readonly outcome: 'unprovable'
      readonly reason: string
      /** 仍属于本操作且可证明的当前工作区修订；只用于保留只读事实。 */
      readonly candidateSnapshotId?: string
      /** 证明失败的原始分类，交给失败事实与诊断引用，不丢失根因。 */
      readonly cause?: unknown
    }

/**
 * 在重建或改写候选工作区之前，按副作用账本、不可变修订归属和实际工作区内容
 * 证明当前候选来自本操作的哪一次写入。证明后先把候选绑定到执行记录，再为原
 * started 记录补一次 completed；不调用模型、不保存新修订、不写正式作品。
 */
export interface SceneGenerationWriteRecovery {
  /**
   * @param bindCandidate - 先用独立证据把候选绑定到执行记录；实现必须在补写完成回执前调用。
   *   调用方只做执行记录写入，不重写文件、不保存修订。
   */
  recoverCandidateWrite(
    execution: SceneGenerationExecution,
    bindCandidate: (candidateSnapshotId: string) => Promise<void>
  ): Promise<SceneCandidateWriteRecoveryResult>
}
