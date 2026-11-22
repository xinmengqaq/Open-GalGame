import type { SceneGenerationScopeDTO } from '../../dto/SceneGenerationDTO'
import type { SceneGenerationStatusVO } from '../../vo/SceneGenerationVO'
import { operationKey } from '../../policies/SceneGenerationIdempotency'
import { toOperationVO, toStatusVO } from '../../mapping/SceneGenerationViewMapper'

import type { SceneGenerationStatusQueryService } from '../SceneGenerationStatusQueryService'
import {
  SceneGenerationCoordinator,
  type SceneGenerationDependencies
} from './SceneGenerationCoordinator'
export class QuerySceneGenerationStatus implements SceneGenerationStatusQueryService {
  constructor(
    private readonly deps: SceneGenerationDependencies,
    private readonly coordinator: SceneGenerationCoordinator
  ) {}
  async getSceneGenerationStatus(
    request: SceneGenerationScopeDTO
  ): Promise<SceneGenerationStatusVO> {
    const execution = await this.coordinator.requireExecution(request)
    const status = toStatusVO(
      execution,
      this.coordinator.activeExecutions.has(operationKey(request))
    )
    if (!this.deps.workflow.capabilities().resume && status.canResume) {
      return {
        ...status,
        canResume: false,
        resumeReason: '当前构建尚未启用继续执行'
      }
    }
    if (
      status.canResume &&
      execution.checkpointId &&
      !execution.requiresCleanup &&
      execution.state !== 'committing'
    ) {
      const checkpoint = await this.deps.history.readCheckpoint(
        execution.forkRequest
          ? execution.fork!
          : { ...toOperationVO(execution), checkpointId: execution.checkpointId }
      )
      return {
        ...status,
        canResume: checkpoint.view.canContinue,
        resumeReason: checkpoint.view.canContinue ? undefined : checkpoint.view.reason
      }
    }
    return status.state === 'failed' || status.state === 'cancelled'
      ? { ...status, resumeReason: '操作已结束，候选仅供查看，不能继续或接受旧交互' }
      : status
  }
}
