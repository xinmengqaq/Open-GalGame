import type {
  SceneGenerationExecution
} from '@application/scene-generation/models/SceneGenerationExecution'
import { completedExecution, requireAcceptable } from '../SceneGenerationApplicationRules'
import { safeFailureWithDiagnosticRef } from '../SceneGenerationFailureFacts'
import type { ActiveSceneGeneration } from '../SceneGenerationCoordinator'
import type { GenerationRuntimePort } from './GenerationRun'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'

type PersistExecution = (
  patch: Partial<SceneGenerationExecution>
) => Promise<SceneGenerationExecution>

export class GenerationCommit {
  async commitGeneration(
    run: GenerationRuntimePort,
    active: ActiveSceneGeneration,
    signal: AbortSignal
  ): Promise<'committed' | 'paused'> {
    await run.updateExecution(active, { step: 'reading' })
    const candidate = await run.deps.artifacts.readCandidate(
      active.execution,
      active.execution.candidateSnapshotId!
    )
    signal.throwIfAborted()
    await run.updateExecution(active, { step: 'validating' })
    const facts = await run.deps.versions.inspectBaseline(active.execution)
    const report = requireAcceptable(active.execution, facts, candidate, run.deps.domain)
    const preview = { ...candidate.preview, validationReport: report }
    // 复核已完成、尚未进入 committing：与暂停受理同段裁决。
    // 已受理暂停优先保留边界和候选；否则原子进入不可撤销提交。
    if (!(await run.enterCommitGate(active, preview, signal))) return 'paused'
    signal.throwIfAborted()
    const commit = await run.deps.versions.commitCandidate(
      active.execution,
      candidate,
      (currentFacts) => {
        signal.throwIfAborted()
        requireAcceptable(active.execution, currentFacts, candidate, run.deps.domain)
      }
    )
    await this.completeExecution(run, active, commit.commitId)
    return 'committed'
  }

  /**
   * 将可靠提交结果持久记录后发布成功，不因预览页后续展示失败回退已保存作品。
   * 清理失败只登记“已提交、清理待处理”，不改写提交结果，也不触发再次提交。
   * @param persist - 已持有短串行段时提供直接持久记录，默认排入短串行段。
   * @throws {AppException} 清理未完成或成功结果持久记录失败；恢复须先查询已有提交。
   */
  async completeExecution(
    run: GenerationRuntimePort,
    active: ActiveSceneGeneration,
    commitId: string,
    persist: PersistExecution = async (patch) => {
      await run.updateExecution(active, patch)
      return active.execution
    }
  ): Promise<void> {
    const completed = completedExecution(active.execution, commitId)
    let workspaceFailure: AppException | undefined
    try {
      await run.deps.workspace.discardWorkspace(active.execution)
    } catch (cleanupError) {
      workspaceFailure = new AppException({
        code: ErrorCodes.internalError,
        msg: '作品已保存，但候选工作区清理未完成',
        cause: cleanupError
      })
    }
    // 恢复边界清理失败不能静默丢弃；正式提交已经发生，只登记待处理事实。
    let boundaryFailure: AppException | undefined
    try {
      await run.clearPauseBoundary(active.execution)
    } catch (cleanupError) {
      boundaryFailure = new AppException({
        code: ErrorCodes.internalError,
        msg: '作品已保存，但恢复边界清理未完成',
        cause: cleanupError
      })
    }
    const cleanupFailure = combinedCleanupFailure(workspaceFailure, boundaryFailure)
    const updated = {
      ...completed,
      workspace: workspaceFailure ? completed.workspace : undefined,
      workspaceCleanupPending: Boolean(workspaceFailure),
      pauseBoundaryCleanupPending: Boolean(boundaryFailure),
      failure: cleanupFailure ? safeFailureWithDiagnosticRef(cleanupFailure) : undefined
    }
    active.execution = await persist(updated)
    if (cleanupFailure) throw cleanupFailure
  }
}

/** 两处提交后清理各自独立；失败仍归属同一次已提交结果，不产生第二次提交。 */
function combinedCleanupFailure(
  workspace: AppException | undefined,
  boundary: AppException | undefined
): AppException | undefined {
  if (workspace === undefined) return boundary
  if (boundary === undefined) return workspace
  return new AppException({
    code: ErrorCodes.internalError,
    msg: '作品已保存，但候选工作区与恢复边界清理未完成',
    cause: new AggregateError([workspace, boundary], '提交后清理失败')
  })
}
