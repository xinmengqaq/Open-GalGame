import type { SceneGenerationExecution } from '@application/scene-generation/models/SceneGenerationExecution'
import type { AiProjectFileSystemImpl } from '@infrastructure/ai/filesystem/AiProjectFileSystemImpl'
import type { GitLocation } from '@infrastructure/git/objects/gitTree'
import { isPiReviewCheckpointId, piReviewCheckpointId } from '../workflow/piReviewCheckpoint'
import { isPublishedRevision, revisionBelongsToOperation } from './RevisionFileDifferences'

/**
 * 分叉来源身份是否能落到一个独立的不可变父修订。只做来源身份与修订归属核对；
 * 不读取来源操作当前的检查点或候选，因此来源继续推进不会使已复制修订失效。
 * @returns 不可证明的安全原因；可以继续核对修订归属时为 undefined。
 */
export function forkSourceRevisionIssue(
  execution: SceneGenerationExecution,
  revisionId: string
): string | undefined {
  const fork = execution.fork
  const sourceOperationId = fork?.sourceOperationId
  if (
    fork === undefined ||
    sourceOperationId === undefined ||
    fork.candidateSnapshotId !== revisionId
  )
    return '分叉父修订不是创建时复制的来源候选'
  if (
    fork.projectId !== execution.projectId ||
    fork.sceneId !== execution.sceneId ||
    fork.threadId !== execution.threadId
  )
    return '分叉来源与当前操作不在同一场景线程'
  if (fork.branchId === execution.branchId) return '分叉来源必须位于另一分支'
  if (sourceOperationId === execution.operationId) return '分叉来源不能是当前操作'
  if (
    isPiReviewCheckpointId(fork.checkpointId) &&
    fork.checkpointId !== piReviewCheckpointId(sourceOperationId, revisionId)
  )
    return '分叉检查点与来源操作和父修订不一致'
  return undefined
}

/**
 * 在共享的线程修订库里证明父修订已发布且提交归属来源操作。
 * 来源操作自己的工作区/当前检查点是否仍存在不参与判定。
 */
export async function proveForkSourceRevision(
  files: AiProjectFileSystemImpl,
  execution: SceneGenerationExecution,
  revisionId: string,
  location?: GitLocation
): Promise<boolean> {
  if (forkSourceRevisionIssue(execution, revisionId) !== undefined) return false
  const sourceOperationId = execution.fork!.sourceOperationId!
  const revisionLocation = location ?? {
    gitdir: files.locateWorkspace({
      projectId: execution.projectId,
      threadId: execution.threadId,
      operationId: sourceOperationId
    }).revisionGitDir
  }
  return (
    (await isPublishedRevision(revisionLocation, revisionId)) &&
    (await revisionBelongsToOperation(revisionLocation, revisionId, sourceOperationId))
  )
}
