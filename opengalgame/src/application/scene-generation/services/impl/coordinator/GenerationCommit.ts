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

/**
 * 提交决策与成功收尾：重读候选、领域校验、短边界复验、受控清理。
 * 只读写协调器提供的执行记录，不持有队列或活动操作表。
 */
export class GenerationCommit {
  /**
   * 重读候选并由领域校验；提交端口在短写入边界再次调用同一领域规则。
   * @param signal - 包含取消与剩余时限的信号。
   * @throws {AppException} 候选不可接受、当前基线变化或正式提交失败。
   */
  async commitGeneration(
    run: GenerationRuntimePort,
    active: ActiveSceneGeneration,
    signal: AbortSignal
  ): Promise<void> {
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
    await run.updateExecution(active, { preview, state: 'committing', step: 'committing' })
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
  }

  /**
   * 将可靠提交结果持久记录后发布成功，不因预览页后续展示失败回退已保存作品。
   * @param persist - 已持有短串行段时提供直接持久记录，默认排入短串行段。
   * @throws {AppException} 成功结果持久记录失败，恢复须先查询已有提交。
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
    let cleanupFailure: AppException | undefined
    try {
      await run.deps.workspace.discardWorkspace(active.execution)
    } catch (cleanupError) {
      cleanupFailure = new AppException({
        code: ErrorCodes.internalError,
        msg: '作品已保存，但候选工作区清理未完成',
        cause: cleanupError
      })
    }
    const updated = {
      ...completed,
      workspace: cleanupFailure ? completed.workspace : undefined,
      workspaceCleanupPending: Boolean(cleanupFailure),
      failure: cleanupFailure ? safeFailureWithDiagnosticRef(cleanupFailure) : undefined
    }
    active.execution = await persist(updated)
    if (cleanupFailure) throw cleanupFailure
  }
}
