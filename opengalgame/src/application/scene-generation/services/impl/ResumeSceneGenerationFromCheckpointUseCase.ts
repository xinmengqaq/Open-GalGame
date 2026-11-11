import type { ResumeSceneGenerationDTO, SceneGenerationScopeDTO } from '../../dto/SceneGenerationDTO'
import type { SceneGenerationStatusVO } from '../../vo/SceneGenerationVO'
import type { SceneGenerationRenderStatusVO } from '../../vo/SceneGenerationRenderVO'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { canResumeInterruptedSceneGeneration, canResumePausedSceneGeneration } from '@domain/scene-generation/services/validateSceneGenerationReply'
import { toRenderStatusVO } from '../../mapping/SceneGenerationRenderProjection'
import type { SceneGenerationServiceContext } from './SceneGenerationServiceContext'

/** 控制端口可调用的恢复能力；由应用服务实现。 */
interface SceneGenerationResumeGateway {
  resumeSceneGeneration(request: SceneGenerationScopeDTO): Promise<SceneGenerationStatusVO>
  resumeAuthorizedPause(request: SceneGenerationScopeDTO): Promise<SceneGenerationStatusVO>
}

export class ResumeSceneGenerationFromCheckpointUseCase {
  constructor(
    private readonly context: SceneGenerationServiceContext,
    private readonly generation: SceneGenerationResumeGateway
  ) {}

  async resumeSceneGeneration(
    request: ResumeSceneGenerationDTO
  ): Promise<SceneGenerationRenderStatusVO> {
    const execution = await this.context.coordinator.requireExecution(request)
    if (
      execution.threadId !== request.threadId ||
      execution.branchId !== request.branchId ||
      execution.checkpointId !== request.checkpointId ||
      (execution.candidateSnapshotId ?? undefined) !== request.candidateSnapshotId
    ) {
      throw new AppException({ code: ErrorCodes.operationConflict, msg: '恢复身份已过期' })
    }
    if (execution.state === 'cancelled' || execution.cancellationRequested === true) {
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '操作已取消，不能继续执行'
      })
    }
    if (
      execution.interruptReason === 'commitUnknown' ||
      execution.interruptReason === 'candidateConflict'
    ) {
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '当前中断不能按普通检查点恢复'
      })
    }
    const checkpoint = await this.context.deps.history.readCheckpoint(request)
    const checkpointView = {
      ...checkpoint.view,
      candidateSnapshotId: checkpoint.candidateSnapshotId
    }
    const paused = canResumePausedSceneGeneration(execution, checkpointView)
    const interrupted = canResumeInterruptedSceneGeneration(execution, checkpointView)
    if (!paused && !interrupted) {
      throw new AppException({ code: ErrorCodes.operationConflict, msg: '当前检查点不能恢复执行' })
    }
    const status = paused
      ? await this.generation.resumeAuthorizedPause(request)
      : await this.generation.resumeSceneGeneration(request)
    const resumed = await this.context.deps.executions.readExecution(request)
    return toRenderStatusVO(resumed ?? { ...execution, state: status.state })
  }
}
