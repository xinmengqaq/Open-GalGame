import type { RetrySceneGenerationRepairDTO } from '../../dto/SceneGenerationDTO'
import type { SceneGenerationRenderStatusVO } from '../../vo/SceneGenerationRenderVO'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { canRetryFailedSceneGenerationRepair } from '@domain/scene-generation/services/validateSceneGenerationReply'
import { toRenderStatusVO } from '../../mapping/SceneGenerationRenderProjection'
import type { SceneGenerationApplicationService } from '../SceneGenerationApplicationService'
import { saveLaunchArrangement } from './SceneGenerationLaunchArrangement'
import { requireLaunchIdentity, requireRepairInstruction } from './SceneGenerationRequestGuards'
import type { SceneGenerationRenderDependencies } from './SceneGenerationRenderDependencies'
import type { SceneGenerationServiceContext } from './SceneGenerationServiceContext'

export class RetrySceneGenerationRepairUseCase {
  constructor(
    private readonly context: SceneGenerationServiceContext,
    private readonly renderDeps: SceneGenerationRenderDependencies,
    private readonly generation: SceneGenerationApplicationService
  ) {}

  async retrySceneGenerationRepair(
    request: RetrySceneGenerationRepairDTO
  ): Promise<SceneGenerationRenderStatusVO> {
    const snapshot = structuredClone(request)
    requireLaunchIdentity(snapshot)
    requireRepairInstruction(snapshot.repair.instruction)
    const source = await this.context.deps.executions.readExecution({
      projectId: snapshot.projectId,
      sceneId: snapshot.sceneId,
      operationId: snapshot.repair.sourceOperationId
    })
    if (
      !source ||
      !canRetryFailedSceneGenerationRepair(source, {
        projectId: snapshot.projectId,
        sceneId: snapshot.sceneId,
        ...snapshot.repair
      })
    ) {
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '来源修复不能重跑，已保留原失败记录'
      })
    }
    if (
      [...this.context.coordinator.activeExecutions.values()].some(
        (operation) =>
          operation.execution.projectId === snapshot.projectId &&
          operation.execution.sceneId === snapshot.sceneId
      ) ||
      (await this.context.deps.executions.findActiveExecution(source))
    ) {
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '来源对话仍有未结束操作，不能开始修复重跑'
      })
    }
    const saved = await saveLaunchArrangement(this.context.deps, this.renderDeps, snapshot)
    const operationId = this.context.deps.nextId()
    await this.generation.retryFailedRepair({ ...snapshot, operationId })
    const execution = await this.context.deps.executions.readExecution({ ...snapshot, operationId })
    if (execution?.mode !== 'repair' || !execution.repairSource || !execution.repairContext) {
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '修复重跑没有绑定来源上下文'
      })
    }
    if (execution.inputSnapshot.arrangementVersion !== saved.arrangementVersion) {
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '修复重跑没有绑定已保存编排版本'
      })
    }
    return toRenderStatusVO(execution)
  }
}
