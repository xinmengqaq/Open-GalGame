import type { SceneGenerationExecution } from '../models/SceneGenerationExecution'

/**
 * 无检查点恢复与提交后清理的公共准入事实。
 * 应用入口、状态查询和页面动作共用同一判据，避免“投影显示可恢复、后端却拒绝”的分叉。
 */

export function hasRecoverableUnfinishedFacts(execution: SceneGenerationExecution): boolean {
  return (
    typeof execution.fingerprint === 'string' &&
    execution.fingerprint !== '' &&
    typeof execution.source?.projectRoot === 'string' &&
    execution.source.projectRoot !== '' &&
    typeof execution.source.sceneDirectory === 'string' &&
    execution.source.sceneDirectory !== '' &&
    typeof execution.source.entryFile === 'string' &&
    execution.source.entryFile !== '' &&
    typeof execution.inputSnapshot === 'object' &&
    execution.inputSnapshot !== null &&
    typeof execution.baseline === 'object' &&
    execution.baseline !== null
  )
}

/**
 * 无检查点恢复的唯一准入判据。返回用户可读原因，null 表示可以继续。
 * 应用入口直接抛这个原因，状态投影只判断 null，避免两侧逐条复制后分叉。
 */
export function unfinishedRecoveryIssue(execution: SceneGenerationExecution): string | null {
  if (execution.checkpointId !== undefined) return '当前操作已有检查点，请按检查点恢复'
  if (execution.state !== 'pending' && execution.state !== 'running')
    return '只有尚未产生检查点的待运行或运行中操作可以继续'
  if (execution.cancellationRequested === true) return '操作已受理取消，不能继续执行'
  if (execution.requiresCleanup === true) return '当前操作有待清理事实，不能继续执行'
  if (execution.pendingReply !== undefined) return '当前操作有已接受的回复，需按检查点恢复'
  if (execution.interruptReason !== undefined) return '当前中断需要先核对，不能继续生成'
  if (!hasRecoverableUnfinishedFacts(execution)) return '操作记录不完整，不能继续生成'
  return null
}

/** 未产生检查点、无活动代次，且没有暂停/待核对/取消/清理/回复事实的崩溃现场。 */
export function canResumeUnfinishedRecovery(
  execution: SceneGenerationExecution,
  activeGeneration: boolean
): boolean {
  return !activeGeneration && unfinishedRecoveryIssue(execution) === null
}

/**
 * 写入/提交回执不明的显式核对入口。只决定“能否展示/接受核对请求”，
 * 不表示可以继续、取消、删除或归档；核对后是否结算由真实回执另行决定。
 */
export function canVerifyUnknownResult(
  execution: SceneGenerationExecution,
  activeGeneration: boolean
): boolean {
  return (
    !activeGeneration &&
    execution.state === 'interrupted' &&
    (execution.interruptReason === 'writeUnknown' ||
      execution.interruptReason === 'commitUnknown')
  )
}

/** 正式提交成功且登记了任一类清理待处理事实。 */
export function hasCommittedCleanupPending(execution: SceneGenerationExecution): boolean {
  return (
    execution.state === 'succeeded' &&
    (execution.workspaceCleanupPending === true ||
      execution.pauseBoundaryCleanupPending === true)
  )
}

/** 无活动代次且已有可复用的提交结果时才显示/接受清理重试。 */
export function canRetryCommittedCleanup(
  execution: SceneGenerationExecution,
  activeGeneration: boolean
): boolean {
  return (
    !activeGeneration &&
    hasCommittedCleanupPending(execution) &&
    execution.result?.commitId !== undefined
  )
}
