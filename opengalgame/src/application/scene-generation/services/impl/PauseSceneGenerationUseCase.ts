import type { SceneGenerationScopeDTO } from '../../dto/SceneGenerationDTO'
import type { SceneGenerationRenderStatusVO } from '../../vo/SceneGenerationRenderVO'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { canRequestSceneGenerationPause } from '@domain/scene-generation/services/validateSceneGenerationReply'
import { operationKey, threadKey } from '../../policies/SceneGenerationIdempotency'
import { toRenderStatusVO } from '../../mapping/SceneGenerationRenderProjection'
import type { SceneGenerationServiceContext } from './SceneGenerationServiceContext'

export class PauseSceneGenerationUseCase {
  constructor(private readonly context: SceneGenerationServiceContext) {}

  async pauseSceneGeneration(
    request: SceneGenerationScopeDTO
  ): Promise<SceneGenerationRenderStatusVO> {
    const execution = await this.context.coordinator.requireExecution(request)
    return this.context.coordinator.serialize(threadKey(execution), async () => {
      const current = await this.context.coordinator.requireExecution(request)
      if (!canRequestSceneGenerationPause(current)) {
        throw new AppException({
          code: ErrorCodes.operationConflict,
          msg: '当前状态不能安全暂停'
        })
      }
      const updated = { ...current, pauseRequested: true, sequence: current.sequence + 1 }
      const written = await this.context.coordinator.writeExecution(updated)
      const active = this.context.coordinator.activeExecutions.get(operationKey(request))
      if (active) active.execution = written.execution
      await this.context.coordinator.requestPause(written.execution)
      return toRenderStatusVO(written.execution, written.canContinue ?? false)
    })
  }
}
