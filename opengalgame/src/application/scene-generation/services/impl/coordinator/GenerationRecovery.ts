import type {
  SceneGenerationExecution
} from '@application/scene-generation/models/SceneGenerationExecution'
import { isTerminal } from '@application/scene-generation/mapping/SceneGenerationViewMapper'
import {
  SceneGenerationVersionConflict
} from '@application/scene-generation/errors/SceneGenerationVersionConflict'
import { safeFailureWithDiagnosticRef } from '../SceneGenerationFailureFacts'
import type { ActiveSceneGeneration } from '../SceneGenerationCoordinator'
import type { GenerationCommit } from './GenerationCommit'
import type { GenerationRuntimePort } from './GenerationRun'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'

/**
 * 失败恢复顺序：先查本操作提交事实，再确认成功、受控回退或清理；结果不明保留候选。
 * 外层已持有短串行段时直接写入，否则经执行记录写入口排队，避免重入队列。
 */
export class GenerationRecovery {
  constructor(private readonly commit: GenerationCommit) {}

  /**
   * @param originalError - 本次失败或取消原因。
   * @param cancelled - 是否由用户取消。
   * @param serialized - 是否需要排入短串行段，外层已经持有队列时直接写入。
   * @throws {AppException} 原始失败及恢复失败保留为 AggregateError；正常取消不抛错。
   */
  async recoverFailure(
    run: GenerationRuntimePort,
    active: ActiveSceneGeneration,
    originalError: unknown,
    cancelled: boolean,
    serialized: boolean
  ): Promise<void> {
    const persist = async (
      patch: Partial<SceneGenerationExecution>
    ): Promise<SceneGenerationExecution> => {
      if (serialized) {
        await run.updateExecution(active, patch)
        return active.execution
      }
      const updated = { ...active.execution, ...patch, sequence: active.execution.sequence + 1 }
      active.execution = (await run.writeExecution(updated)).execution
      return active.execution
    }
    let commitUnknown = false
    let candidateConflict = false
    try {
      const commit = await run.deps.versions.readOperationCommit(active.execution)
      if (commit.state === 'committed') {
        await this.commit.completeExecution(run, active, commit.commitId, persist)
        return
      }
      if (commit.state === 'unknown') {
        await persist({
          state: 'interrupted',
          interruptReason: 'commitUnknown',
          failure: safeFailureWithDiagnosticRef(originalError, candidateFacts(active.execution)),
          live: undefined,
          requiresCleanup: true,
          cancellationRequested: cancelled
        })
        commitUnknown = true
      } else if (
        commit.state === 'notCommitted' &&
        !cancelled &&
        originalError instanceof SceneGenerationVersionConflict &&
        active.execution.candidateSnapshotId
      ) {
        await persist({
          state: 'interrupted',
          interruptReason: 'candidateConflict',
          failure: safeFailureWithDiagnosticRef(originalError, candidateFacts(active.execution)),
          live: undefined,
          requiresCleanup: false
        })
        candidateConflict = true
      } else {
        if (commit.state === 'rollbackRequired') {
          await persist({ step: 'rollingBack' })
          const rollback = await run.deps.versions.rollbackCandidate(
            active.execution,
            commit.commitId
          )
          await persist(rollback)
        }
        await run.deps.workspace.discardWorkspace(active.execution)
        await persist({
          state: cancelled ? 'cancelled' : 'failed',
          step: undefined,
          interaction: undefined,
          pendingReply: undefined,
          live: undefined,
          failure: cancelled
            ? undefined
            : safeFailureWithDiagnosticRef(originalError, candidateFacts(active.execution)),
          requiresCleanup: false,
          cancellationRequested: cancelled
        })
      }
    } catch (recoveryError) {
      const failures = [originalError, recoveryError]
      if (active.execution.state !== 'interrupted' && !isTerminal(active.execution)) {
        try {
          await persist({
            state: 'interrupted',
            failure: safeFailureWithDiagnosticRef(originalError, candidateFacts(active.execution)),
            live: undefined,
            requiresCleanup: true,
            cancellationRequested: cancelled
          })
        } catch (recordingError) {
          failures.push(recordingError)
        }
      }
      throw new AppException({
        code: ErrorCodes.internalError,
        msg: '场景生成未完整结束，请核对并恢复该操作',
        cause: new AggregateError(failures, '场景生成与恢复失败')
      })
    }
    if (commitUnknown)
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '作品提交结果尚未查明，已保留候选与恢复记录',
        cause: originalError
      })
    if (candidateConflict || !cancelled) throw originalError
  }
}

/** 失败时仍可读的候选只给只读授权；没有候选修订时不补造事实。 */
function candidateFacts(
  execution: SceneGenerationExecution
): { candidateSnapshotId: string; previewAuthorization: 'readOnly' } | undefined {
  return execution.candidateSnapshotId
    ? { candidateSnapshotId: execution.candidateSnapshotId, previewAuthorization: 'readOnly' }
    : undefined
}
