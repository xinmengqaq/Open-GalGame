import type { SceneGenerationScopeDTO } from '../../dto/SceneGenerationDTO'
import type { SceneGenerationExecution, SceneGenerationRuntime } from '../../models/SceneGenerationExecution'
import type { SceneGenerationStatusVO } from '../../vo/SceneGenerationVO'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { operationKey, threadKey } from '../../policies/SceneGenerationIdempotency'
import { isTerminal, toOperationVO, toStatusVO } from '../../mapping/SceneGenerationViewMapper'
import type { SceneGenerationServiceContext } from './SceneGenerationServiceContext'

export async function resumeExecution(
  context: SceneGenerationServiceContext,
  request: SceneGenerationScopeDTO,
  pauseAuthorized: boolean
): Promise<SceneGenerationStatusVO> {
  const execution = await context.coordinator.requireExecution(request)
  return context.coordinator.serialize(threadKey(execution), async () => {
    const current = await context.coordinator.requireExecution(request)
    const persist = async (
      patch: Partial<SceneGenerationExecution>
    ): Promise<SceneGenerationExecution> => {
      const updated = { ...current, ...patch, sequence: current.sequence + 1 }
      return (await context.coordinator.writeExecution(updated)).execution
    }
    if (
      current.state === 'succeeded' &&
      current.workspaceCleanupPending &&
      !context.coordinator.activeExecutions.has(operationKey(request))
    ) {
      const cleanup = { execution: current, controller: new AbortController() }
      await context.coordinator.completeExecution(cleanup, current.result!.commitId, persist)
      return toStatusVO(cleanup.execution, false)
    }
    if (isTerminal(current) || context.coordinator.activeExecutions.has(operationKey(request))) {
      return toStatusVO(current, context.coordinator.activeExecutions.has(operationKey(request)))
    }
    if (
      current.interruptReason === 'commitUnknown' ||
      current.interruptReason === 'candidateConflict'
    ) {
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '当前中断不能按普通暂停恢复'
      })
    }
    if (current.interruptReason === 'paused' && !pauseAuthorized) {
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '暂停恢复必须绑定当前检查点与候选'
      })
    }
    if (
      (current.state === 'cancelled' || current.cancellationRequested === true) &&
      !current.requiresCleanup &&
      current.state !== 'interrupted'
    ) {
      return toStatusVO(current, false)
    }
    const commit = await context.deps.versions.readOperationCommit(current)
    if (commit.state === 'unknown')
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '作品提交结果尚未查明，不能继续执行'
      })
    if (commit.state === 'committed') {
      const completed = { execution: current, controller: new AbortController() }
      await context.coordinator.completeExecution(completed, commit.commitId, persist)
      return toStatusVO(completed.execution, false)
    }
    if (
      commit.state === 'rollbackRequired' ||
      current.state === 'cancelling' ||
      current.pendingReply?.reply.kind === 'discard' ||
      current.requiresCleanup
    ) {
      const recovery = { execution: current, controller: new AbortController() }
      const originalError = new AppException({
        code: current.failure?.code ?? ErrorCodes.operationConflict,
        msg: current.failure?.message ?? '上次操作未完整结束'
      })
      try {
        await context.coordinator.recoverFailure(
          recovery,
          originalError,
          Boolean(
            current.cancellationRequested ||
            current.state === 'cancelling' ||
            current.pendingReply?.reply.kind === 'discard'
          ),
          false
        )
      } catch (error) {
        if (error !== originalError) throw error
      }
      return toStatusVO(recovery.execution, false)
    }
    if (current.state === 'waiting' && !current.pendingReply) return toStatusVO(current, false)
    if (current.checkpointId) {
      const checkpoint = await context.deps.history.readCheckpoint(
        current.forkRequest
          ? current.fork!
          : { ...toOperationVO(current), checkpointId: current.checkpointId }
      )
      if (!checkpoint.view.canContinue)
        throw new AppException({
          code: ErrorCodes.operationConflict,
          msg: checkpoint.view.reason ?? '当前检查点不能恢复执行'
        })
    }
    const inspected = await context.coordinator.requireCurrentBaseline(current)
    const updated = {
      ...inspected,
      state: 'pending' as const,
      failure: undefined,
      pauseRequested: false,
      interruptReason: current.state === 'running' ? undefined : current.interruptReason
    }
    const recorded = await context.deps.executions.writeExecution(updated)
    const workflowExecution = current.pendingReply
      ? (runtime: SceneGenerationRuntime) => context.deps.workflow.continueInteraction(runtime)
      : current.forkRequest
        ? (runtime: SceneGenerationRuntime) =>
            context.deps.workflow.forkGeneration(runtime, current.forkRequest!)
        : current.state === 'pending' && !current.checkpointId && !current.workspace
          ? (runtime: SceneGenerationRuntime) => context.deps.workflow.executeGeneration(runtime)
          : (runtime: SceneGenerationRuntime) => context.deps.workflow.resumeGeneration(runtime)
    context.coordinator.startExecution(
      recorded,
      workflowExecution,
      Boolean(current.checkpointId || current.workspace)
    )
    return toStatusVO(recorded, true)
  })
}
