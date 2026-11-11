import type { SceneGenerationMemoryGateway } from '@application/scene-generation/ports/SceneGenerationMemoryGateway'
import type { SceneGenerationThreadDTO } from '@application/scene-generation/dto/SceneGenerationDTO'
import { isTerminal } from '@application/scene-generation/mapping/SceneGenerationViewMapper'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { cleanupWorkflowState } from '@infrastructure/workflow/cleanup/cleanupWorkflowState'
import { recordOperationPhase } from '@infrastructure/workflow/checkpoints/checkpointPath'
import type { FileSceneGenerationExecutionRepositoryImpl } from '../execution/FileSceneGenerationExecutionRepositoryImpl'

export class SceneGenerationMemoryGatewayImpl implements SceneGenerationMemoryGateway {
  constructor(
    private readonly stateRoot: string,
    private readonly executions: FileSceneGenerationExecutionRepositoryImpl
  ) {}

  /** 原子应用终态作为清理前提，按共用引用协调清理，不修改正式文件。 */
  async clearMemory(scope: SceneGenerationThreadDTO): Promise<void> {
    const operations = await this.executions.listThread(scope)
    if (operations.some((item) => !isTerminal(item) || item.workspaceCleanupPending))
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '线程仍有活动操作或待清理候选'
      })
    for (const operation of operations)
      await recordOperationPhase(
        this.stateRoot,
        operation,
        operation.state === 'succeeded'
          ? 'finished'
          : operation.state === 'cancelled'
            ? 'cancelled'
            : 'failed'
      )
    await cleanupWorkflowState({
      stateRoot: this.stateRoot,
      ...scope,
      branchIds: [...new Set(operations.map((item) => item.branchId))],
      projectRoot: operations[0]?.source.projectRoot
    })
  }
}
