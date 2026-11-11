import type { SceneGenerationScopeDTO } from '../../dto/SceneGenerationDTO'
import type { SceneGenerationStatusVO } from '../../vo/SceneGenerationVO'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { operationKey, threadKey } from '../../policies/SceneGenerationIdempotency'
import { isTerminal, toStatusVO } from '../../mapping/SceneGenerationViewMapper'
import type { ActiveSceneGeneration } from './SceneGenerationCoordinator'
import type { SceneGenerationServiceContext } from './SceneGenerationServiceContext'

export class CancelSceneGenerationUseCase {
  constructor(private readonly context: SceneGenerationServiceContext) {}

  /**
   * 把取消信号直接交给执行中的工作流，等待状态通过独立清理结束。
   * @returns 取消后的持久操作状态。
   * @throws {AppException} 操作不存在或取消恢复记录失败。
   */
  async cancelSceneGeneration(request: SceneGenerationScopeDTO): Promise<SceneGenerationStatusVO> {
    this.context.coordinator.activeExecutions
      .get(operationKey(request))
      ?.controller.abort(
        new AppException({ code: ErrorCodes.operationConflict, msg: '场景生成已取消' })
      )
    const execution = await this.context.coordinator.requireExecution(request)
    return this.context.coordinator.serialize(threadKey(execution), async () => {
      const current = await this.context.coordinator.requireExecution(request)
      if (isTerminal(current)) return toStatusVO(current, false)
      const active = this.context.coordinator.activeExecutions.get(operationKey(request))
      if (active) {
        active.controller.abort(
          new AppException({ code: ErrorCodes.operationConflict, msg: '场景生成已取消' })
        )
        const updated = {
          ...active.execution,
          state: 'cancelling' as const,
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
      cancellation.controller.abort()
      await this.context.coordinator.recoverFailure(
        cancellation,
        new AppException({ code: ErrorCodes.operationConflict, msg: '场景生成已取消' }),
        true,
        false
      )
      return toStatusVO(cancellation.execution, false)
    })
  }
}
