import type { SceneGenerationScopeDTO } from '../../dto/SceneGenerationDTO'
import type { SceneGenerationStatusVO } from '../../vo/SceneGenerationVO'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { operationKey, threadKey } from '../../policies/SceneGenerationIdempotency'
import { toStatusVO } from '../../mapping/SceneGenerationViewMapper'
import { isTerminalState } from '../../mapping/SceneGenerationStateProjection'
import type { SceneGenerationExecution } from '../../models/SceneGenerationExecution'
import type { ActiveSceneGeneration } from './SceneGenerationCoordinator'
import type { SceneGenerationServiceContext } from './SceneGenerationServiceContext'

const cancellationReason = (): AppException =>
  new AppException({ code: ErrorCodes.operationConflict, msg: '场景生成已取消' })

/**
 * 取消只在与提交门相同的线程串行段内裁决：先按当前持久事实确认是否已越过
 * 不可撤销提交，再决定中止运行或拒绝。提交中、已提交和已结束都不能伪报取消成功。
 */
export class CancelSceneGenerationUseCase {
  constructor(private readonly context: SceneGenerationServiceContext) {}

  /**
   * 把取消信号直接交给执行中的工作流；无活动运行时复用既有取消清理。
   * @returns 已受理取消或已取消的持久操作状态；不会等待模型返回。
   * @throws {AppException} 操作不存在、正在提交、已经提交/结束或清理失败。
   */
  async cancelSceneGeneration(request: SceneGenerationScopeDTO): Promise<SceneGenerationStatusVO> {
    // 线程身份不会随操作推进变化；先读一次只为取得同一串行键。
    const initial = await this.context.coordinator.requireExecution(request)
    return this.context.coordinator.serialize(threadKey(initial), async () => {
      const current = await this.context.coordinator.requireExecution(request)
      if (current.state === 'cancelled')
        return toStatusVO(
          current,
          this.context.coordinator.activeExecutions.has(operationKey(request))
        )
      // 取消前重新核对写入/提交待核对现场：仍不明时保留现场；已证明提交则如实说明。
      await this.verifyPendingVerification(current)
      this.assertCancellable(current)
      const active = this.context.coordinator.activeExecutions.get(operationKey(request))
      if (active) {
        this.assertCancellable(active.execution)
        // 重复取消不再推进序号；只补一次中止信号，保持控制入口幂等。
        if (current.state === 'cancelling' && current.cancellationRequested === true) {
          active.controller.abort(cancellationReason())
          return toStatusVO(active.execution, true)
        }
        active.controller.abort(cancellationReason())
        const updated = {
          ...active.execution,
          state: 'cancelling' as const,
          // 取消受理即持久事实：崩溃或被旧运行迟到写入后，重开仍能辨认并完成清理。
          cancellationRequested: true,
          // 已受理取消不能再把旧交互或待执行回复暴露为可用入口。
          interaction: undefined,
          pendingReply: undefined,
          pauseRequested: false,
          sequence: active.execution.sequence + 1
        }
        const recorded = (await this.context.coordinator.writeExecution(updated)).execution
        active.execution = recorded
        return toStatusVO(recorded, true)
      }
      const cancellation: ActiveSceneGeneration = {
        execution: current,
        controller: new AbortController()
      }
      cancellation.controller.abort(cancellationReason())
      try {
        await this.context.coordinator.recoverFailure(
          cancellation,
          cancellationReason(),
          true,
          false
        )
      } catch (error) {
        if (cancellation.execution.state === 'succeeded')
          throw new AppException({
            code: ErrorCodes.operationConflict,
            msg: '作品已提交，不能取消',
            cause: error
          })
        throw new AppException({
          code: ErrorCodes.internalError,
          msg: '取消尚未完成清理，请重试结束本次生成并核对作品状态',
          cause: error
        })
      }
      // 清理先核对提交事实：若提交已经发生，只能如实返回成功作品，不能声称已取消。
      if (cancellation.execution.state === 'succeeded')
        throw new AppException({ code: ErrorCodes.operationConflict, msg: '作品已提交，不能取消' })
      if (cancellation.execution.state !== 'cancelled')
        throw new AppException({
          code: ErrorCodes.internalError,
          msg: '取消尚未完成清理，请重试结束本次生成并核对作品状态'
        })
      return toStatusVO(cancellation.execution, false)
    })
  }

  /**
   * 待核对现场不能由普通取消清理。重新读取提交事实只用于如实告知，
   * 不在取消入口补造成功或删除工作区；证据核对仍由恢复边界负责。
   * @throws {AppException} 仍待核对或作品已提交时明确拒绝。
   */
  private async verifyPendingVerification(
    execution: SceneGenerationExecution
  ): Promise<void> {
    if (
      execution.interruptReason !== 'writeUnknown' &&
      execution.interruptReason !== 'commitUnknown'
    )
      return
    let committed = false
    try {
      const commit = await this.context.deps.versions.readOperationCommit(execution)
      committed = commit.state === 'committed'
    } catch {
      committed = false
    }
    throw new AppException({
      code: ErrorCodes.operationConflict,
      msg: committed
        ? '作品已提交，不能取消；请核对作品与清理状态'
        : execution.interruptReason === 'commitUnknown'
          ? '作品提交结果尚未查明，已保留现场待核对，不能取消'
          : '候选写入结果尚未查明，已保留现场待核对，不能取消'
    })
  }

  /**
   * @throws {AppException} 已提交、提交中、已结束或待核对的操作不能受理取消。
   */
  private assertCancellable(
    execution: Pick<SceneGenerationExecution, 'state' | 'result' | 'interruptReason'>
  ): void {
    if (
      execution.interruptReason === 'writeUnknown' ||
      execution.interruptReason === 'commitUnknown'
    )
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg:
          execution.interruptReason === 'commitUnknown'
            ? '作品提交结果尚未查明，已保留现场待核对，不能取消'
            : '候选写入结果尚未查明，已保留现场待核对，不能取消'
      })
    if (execution.state === 'succeeded' || execution.result !== undefined)
      throw new AppException({ code: ErrorCodes.operationConflict, msg: '作品已提交，不能取消' })
    if (execution.state === 'committing')
      throw new AppException({ code: ErrorCodes.operationConflict, msg: '正在提交作品，不能取消' })
    if (isTerminalState(execution.state))
      throw new AppException({ code: ErrorCodes.operationConflict, msg: '本次生成已结束，不能取消' })
  }
}
