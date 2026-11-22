import type {
  SceneGenerationExecution
} from '@application/scene-generation/models/SceneGenerationExecution'
import { isTerminal } from '@application/scene-generation/mapping/SceneGenerationViewMapper'
import {
  SceneGenerationVersionConflict
} from '@application/scene-generation/errors/SceneGenerationVersionConflict'
import { SceneGenerationWriteOutcomeUnknown } from '@application/scene-generation/errors/SceneGenerationWriteOutcomeUnknown'
import { SceneGenerationReadInterrupted } from '@application/scene-generation/errors/SceneGenerationReadInterrupted'
import type { SceneGenerationFailureFact } from '@application/scene-generation/models/SceneGenerationFailureFacts'
import { safeFailureWithDiagnosticRef } from '../SceneGenerationFailureFacts'
import type { ActiveSceneGeneration } from '../SceneGenerationCoordinator'
import type { GenerationCommit } from './GenerationCommit'
import type { GenerationRuntimePort } from './GenerationRun'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'

export class GenerationRecovery {
  constructor(private readonly commit: GenerationCommit) {}

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
      // 失败/取消即使尚未启动工作流，也必须留下可被历史读取的操作边界；
      // 标识由工作流实现提供，应用只作为不透明事实持久化。
      const bounded =
        patch.state !== undefined &&
        patch.checkpointId === undefined &&
        active.execution.checkpointId === undefined
          ? { ...patch, checkpointId: run.deps.workflow.checkpointIdFor(active.execution) }
          : patch
      if (serialized) {
        await run.updateExecution(active, bounded)
        return active.execution
      }
      const updated = { ...active.execution, ...bounded, sequence: active.execution.sequence + 1 }
      active.execution = (await run.writeExecution(updated)).execution
      return active.execution
    }
    let commitUnknown = false
    let candidateConflict = false
    let writeUnknown = false
    let readInterrupted = false
    let unverifiedCancel = false
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
          failure: failureForRecovery(active, originalError, cancelled),
          live: undefined,
          step: undefined,
          interaction: undefined,
          pendingReply: undefined,
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
          step: undefined,
          // 冲突保留候选与作者内容，但已接受的回复不能继续重放；只允许只读核对或结束本次。
          interaction: undefined,
          pendingReply: undefined,
          requiresCleanup: false
        })
        candidateConflict = true
      } else if (
        commit.state === 'notCommitted' &&
        originalError instanceof SceneGenerationWriteOutcomeUnknown
      ) {
        // 文件写入回执不明：保留回答、候选与副作用账本，只进入待核对；
        // 不清理工作区、不补写完成记录，也不走正式提交的 commitUnknown。
        await persist({
          state: 'interrupted',
          interruptReason: 'writeUnknown',
          failure: safeFailureWithDiagnosticRef(originalError, candidateFacts(active.execution)),
          live: undefined,
          step: undefined,
          interaction: undefined,
          requiresCleanup: false,
          cancellationRequested: cancelled
        })
        writeUnknown = true
      } else if (
        commit.state === 'notCommitted' &&
        !cancelled &&
        originalError instanceof SceneGenerationReadInterrupted
      ) {
        // 候选修订与完成回执已保存，只有正文读取中断：保留候选、工作区与账本，
        // 进入可继续的 reading 边界；不清理、不补写，也不重复调用模型。
        await persist({
          state: 'interrupted',
          interruptReason: 'readInterrupted',
          failure: safeFailureWithDiagnosticRef(originalError, candidateFacts(active.execution)),
          live: undefined,
          step: 'reading',
          interaction: undefined,
          pendingReply: undefined,
          requiresCleanup: false,
          cancellationRequested: false
        })
        readInterrupted = true
      } else if (
        cancelled &&
        (active.execution.interruptReason === 'writeUnknown' ||
          active.execution.interruptReason === 'commitUnknown')
      ) {
        // 待核对现场可能仍有唯一草稿；普通取消或自动清理都不能删除其工作区。
        // 保持原记录，等待证据核对路径结算，不由取消入口替作者放弃。
        unverifiedCancel = true
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
          // 普通失败/取消不是可恢复中断；清掉上一轮读取或暂停原因，避免状态与历史继续声称中断。
          interruptReason: undefined,
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
            failure: failureForRecovery(active, originalError, cancelled),
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
    if (unverifiedCancel)
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '当前现场仍需核对，不能按取消清理',
        cause: originalError
      })
    if (commitUnknown)
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '作品提交结果尚未查明，已保留候选与恢复记录',
        cause: originalError
      })
    if (writeUnknown)
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '候选写入回执不明，已保留记录待核对',
        cause: originalError
      })
    if (readInterrupted) throw originalError
    if (candidateConflict || !cancelled) throw originalError
  }
}

function candidateFacts(
  execution: SceneGenerationExecution
): { candidateSnapshotId: string; previewAuthorization: 'readOnly' } | undefined {
  return execution.candidateSnapshotId
    ? { candidateSnapshotId: execution.candidateSnapshotId, previewAuthorization: 'readOnly' }
    : undefined
}

/**
 * 取消清理可能是重试入口：清理失败或提交结果不明时保留此前已经记录的原失败，
 * 不用新的“已取消”请求覆盖提交错误。
 */
function failureForRecovery(
  active: ActiveSceneGeneration,
  originalError: unknown,
  cancelled: boolean
): SceneGenerationFailureFact {
  if (cancelled && active.execution.failure) return active.execution.failure
  return safeFailureWithDiagnosticRef(originalError, candidateFacts(active.execution))
}
