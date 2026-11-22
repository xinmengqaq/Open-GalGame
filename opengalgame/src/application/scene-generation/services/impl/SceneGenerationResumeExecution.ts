import type { SceneGenerationScopeDTO } from '../../dto/SceneGenerationDTO'
import type {
  SceneGenerationExecution,
  SceneGenerationRuntime,
  SceneGenerationWorkflowOutcome
} from '../../models/SceneGenerationExecution'
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
      (current.workspaceCleanupPending || current.pauseBoundaryCleanupPending) &&
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
      current.interruptReason === 'candidateConflict' ||
      current.interruptReason === 'writeUnknown'
    ) {
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '当前中断不能按普通暂停恢复'
      })
    }
    if (
      current.interruptReason === 'paused' &&
      !pauseAuthorized &&
      current.state !== 'cancelling' &&
      current.cancellationRequested !== true
    ) {
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '暂停恢复必须绑定当前检查点与候选'
      })
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
      current.cancellationRequested === true ||
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
    // 新等待发布前已接受的回复只属于上一条交互；若等待记录本身完整，
    // 已完成的旧回复不能作为新等待的授权被重放，也不能因此丢弃当前工作区。
    if (current.state === 'waiting' && supersededWaitingReply(current)) {
      const cleared = await persist({
        pendingReply: undefined,
        ...(current.pauseRequested === true ? { pauseRequested: false } : {})
      })
      return toStatusVO(cleared, false)
    }
    if (current.state === 'waiting' && !current.pendingReply) return toStatusVO(current, false)
    const capabilities = context.deps.workflow.capabilities()
    if (current.pendingReply && !capabilities.continueInteraction) {
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '当前构建尚未启用该交互回复，等待保持不变'
      })
    }
    if (current.forkRequest && !capabilities.fork) {
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '当前构建尚未启用历史分叉，原分支保持不变'
      })
    }
    if (
      !current.pendingReply &&
      !current.forkRequest &&
      current.checkpointId &&
      !capabilities.resume
    ) {
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '当前构建尚未启用检查点继续，原记录保持不变'
      })
    }
    // running 表示上一代次已经在用户授权后启动；进程崩溃后不能只凭检查点视图
    // 判定“不能继续”，否则在途写入的归属恢复永远跑不到。恢复门仍会先核对账本、
    // 修订、输入与工作区字节；证明不了就停在待核对，不绕过归属检查。
    // 分叉展示记录里的 checkpointId 是来源 C1；一旦分叉自己发布了检查点，
    // 当前 checkpointId 已属于本操作，不能再拿来源 C1 当恢复前提。来源推进后
    // C1 可能已不存在，来源证据由 forkGeneration 的不可变来源证明负责。
    const readsSourceCheckpoint =
      current.forkRequest !== undefined &&
      current.fork?.checkpointId === current.checkpointId
    if (current.checkpointId && current.state !== 'running') {
      const checkpoint = await context.deps.history.readCheckpoint(
        readsSourceCheckpoint
          ? current.fork!
          : { ...toOperationVO(current), checkpointId: current.checkpointId }
      )
      // 暂停期间保留的待执行回复走显式暂停授权；普通崩溃回复要求当前等待可回复，
      // 不能用检查点续跑资格代替审阅授权。
      if (current.pendingReply) {
        const replyAuthorized =
          current.interruptReason === 'paused'
            ? checkpoint.view.canContinue === true
            : checkpoint.view.canReply === true
        if (!replyAuthorized)
          throw new AppException({
            code: ErrorCodes.operationConflict,
            msg: '当前等待缺少可靠回复依据'
          })
      } else if (readsSourceCheckpoint) {
        // 还没产生本操作检查点时才在入口核对来源能否复制；不用来源的续跑资格冒充。
        if (checkpoint.view.canFork !== true)
          throw new AppException({
            code: ErrorCodes.operationConflict,
            msg: checkpoint.view.reason ?? '该历史检查点不能分叉'
          })
      } else if (!current.forkRequest && !checkpoint.view.canContinue)
        throw new AppException({
          code: ErrorCodes.operationConflict,
          msg: checkpoint.view.reason ?? '当前检查点不能恢复执行'
        })
    }
    const inspected = await context.coordinator.requireCurrentBaseline(current)
    const updated = {
      ...inspected,
      state: 'pending' as const,
      // 每次显式继续开启新一代次；暂停边界与旧迟到回执都不能跨代次复用。
      attempt: current.attempt + 1,
      failure: undefined,
      pauseRequested: false,
      interruptReason: current.state === 'running' ? undefined : current.interruptReason
    }
    const recorded = await context.deps.executions.writeExecution(updated)
    // 恢复门可能绑定新候选或消费旧检查点/分叉请求；入口必须按恢复后的持久事实选择，
    // 不能沿用启动前快照里已经失效的决定。无检查点且无候选的现场是启动后/物化修复
    // 输入后的崩溃点，仍走首次生成（修复输入由执行编排重新证明并复用），不能把已物化
    // 的 repairInputSnapshotId 当成候选修订去调 resumeGeneration。
    const noCandidateBoundary =
      current.checkpointId === undefined && current.candidateSnapshotId === undefined
    const workflowExecution = (
      runtime: SceneGenerationRuntime
    ): Promise<SceneGenerationWorkflowOutcome> => {
      const latest = runtime.execution
      if (latest.pendingReply)
        return context.deps.workflow.continueInteraction(runtime)
      if (latest.forkRequest)
        return context.deps.workflow.forkGeneration(runtime, latest.forkRequest)
      if (
        noCandidateBoundary &&
        latest.checkpointId === undefined &&
        latest.candidateSnapshotId === undefined
      )
        return context.deps.workflow.executeGeneration(runtime)
      return context.deps.workflow.resumeGeneration(runtime)
    }
    context.coordinator.startExecution(
      recorded,
      workflowExecution,
      Boolean(current.checkpointId || current.workspace)
    )
    return toStatusVO(recorded, true)
  })
}

/**
 * 重开时判断 waiting 里的旧回复是否已被后续等待取代。
 * 只有确实写入 replies 的已完成回复才消费；新交互本身仍留给作者操作。
 */
function supersededWaitingReply(execution: SceneGenerationExecution): boolean {
  const pending = execution.pendingReply
  const interaction = execution.interaction
  if (!pending || !interaction) return false
  const completed = execution.replies.some(
    (reply) => reply.replyId === pending.replyId && reply.interactionId === pending.interactionId
  )
  if (!completed) return false
  if (pending.interactionId !== interaction.interactionId) return true
  return (
    pending.reply.kind === 'accept' && pending.candidateSnapshotId !== execution.candidateSnapshotId
  )
}
