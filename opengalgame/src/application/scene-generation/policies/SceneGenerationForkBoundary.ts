import type { SceneGenerationExecution } from '../models/SceneGenerationExecution'

/**
 * 分叉来源的当前身份与持久边界。检查点里的执行快照只说明历史，
 * 不能替代当前执行记录、活动操作和线程约束。
 */
export interface SceneGenerationForkBoundary {
  readonly projectId: string
  readonly sceneId: string
  readonly operationId: string
  readonly threadId: string
  readonly branchId: string
  readonly checkpointId: string
  readonly candidateSnapshotId?: string
}

/**
 * 当前执行记录是否仍停在该可复制边界。
 * @returns 不可分叉的安全原因；仍可分叉时为 undefined。
 */
export function forkSourceRecordReason(
  record: SceneGenerationExecution | null | undefined,
  boundary: SceneGenerationForkBoundary
): string | undefined {
  if (!record) return '来源执行记录缺失，不能分叉'
  if (
    record.projectId !== boundary.projectId ||
    record.sceneId !== boundary.sceneId ||
    record.operationId !== boundary.operationId ||
    record.threadId !== boundary.threadId ||
    record.branchId !== boundary.branchId
  )
    return '来源执行记录与历史边界不一致，不能分叉'
  if (boundary.candidateSnapshotId === undefined)
    return '来源没有可复制的候选修订，不能分叉'
  if (record.checkpointId !== boundary.checkpointId)
    return '执行记录已不在该历史边界，不能分叉'
  if (record.candidateSnapshotId !== boundary.candidateSnapshotId)
    return '执行记录候选与历史候选不一致，不能分叉'
  if (record.pendingReply !== undefined) return '仍有待执行回复，不能分叉'
  const paused = record.state === 'interrupted' && record.interruptReason === 'paused'
  if (record.state !== 'waiting' && !paused)
    return '来源当前不在等待审阅或安全暂停，不能分叉'
  return undefined
}
