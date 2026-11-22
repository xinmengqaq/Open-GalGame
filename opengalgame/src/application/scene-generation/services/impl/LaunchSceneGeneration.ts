import type {
  ForkSceneGenerationFromHistoryDTO,
  RetrySceneGenerationRepairDTO,
  StartSceneGenerationDTO
} from '../../dto/SceneGenerationDTO'
import type {
  SceneGenerationForkVO,
  SceneGenerationRenderStatusVO
} from '../../vo/SceneGenerationRenderVO'
import type { SceneGenerationExecution } from '../../models/SceneGenerationExecution'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { toRenderStatusVO } from '../../mapping/SceneGenerationRenderProjection'
import type { SceneGenerationApplicationService } from '../SceneGenerationApplicationService'
import type { SceneGenerationLaunchService } from '../SceneGenerationLaunchService'
import { RetrySceneGenerationRepairUseCase } from './RetrySceneGenerationRepairUseCase'
import { StartSceneGenerationUseCase } from './StartSceneGenerationUseCase'
import type {
  SceneGenerationCoordinator,
  SceneGenerationDependencies
} from './SceneGenerationCoordinator'
import type { SceneGenerationRenderDependencies } from './SceneGenerationRenderDependencies'
import type { SceneGenerationServiceContext } from './SceneGenerationServiceContext'

export class LaunchSceneGeneration implements SceneGenerationLaunchService {
  private readonly context: SceneGenerationServiceContext
  private readonly start: StartSceneGenerationUseCase
  private readonly retryRepair: RetrySceneGenerationRepairUseCase

  constructor(
    deps: SceneGenerationDependencies,
    renderDeps: SceneGenerationRenderDependencies,
    private readonly generation: SceneGenerationApplicationService,
    coordinator: SceneGenerationCoordinator
  ) {
    this.context = { deps, coordinator }
    this.start = new StartSceneGenerationUseCase(this.context, renderDeps, generation)
    this.retryRepair = new RetrySceneGenerationRepairUseCase(
      this.context,
      renderDeps,
      generation
    )
  }

  async startSceneGeneration(
    request: StartSceneGenerationDTO
  ): Promise<SceneGenerationRenderStatusVO> {
    return this.start.startSceneGeneration(request)
  }

  async retrySceneGenerationRepair(
    request: RetrySceneGenerationRepairDTO
  ): Promise<SceneGenerationRenderStatusVO> {
    return this.retryRepair.retrySceneGenerationRepair(request)
  }

  /**
   * 应用服务负责重新证明来源；这里只生成新操作身份，并在返回界面前再次核对
   * 新执行记录确实绑定到请求的来源分支与检查点。来源摘要来自同一次应用读取。
   */
  async forkSceneGeneration(
    request: ForkSceneGenerationFromHistoryDTO
  ): Promise<SceneGenerationForkVO> {
    const operationId = this.context.deps.nextId()
    const fork = await this.generation.forkSceneGeneration({
      projectId: request.projectId,
      sceneId: request.sceneId,
      threadId: request.threadId,
      branchId: request.branchId,
      checkpointId: request.checkpointId,
      operationId,
      policy: request.policy
    })
    const execution = await this.context.deps.executions.readExecution({
      projectId: request.projectId,
      sceneId: request.sceneId,
      operationId
    })
    if (!execution || !forkBindsSource(execution, request)) {
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '分叉没有绑定来源历史，已保留原分支'
      })
    }
    return {
      status: toRenderStatusVO(
        execution,
        false,
        this.context.deps.workflow.capabilities(),
        true
      ),
      source: fork.forkFrom
    }
  }
}

/** 新操作必须停在新分支，并在持久记录里指向请求的来源线程、分支和检查点。 */
function forkBindsSource(
  execution: SceneGenerationExecution,
  request: ForkSceneGenerationFromHistoryDTO
): boolean {
  const fork = execution.fork
  return (
    fork !== undefined &&
    fork.projectId === request.projectId &&
    fork.threadId === request.threadId &&
    fork.branchId === request.branchId &&
    fork.checkpointId === request.checkpointId &&
    execution.branchId !== request.branchId &&
    fork.candidateSnapshotId !== undefined
  )
}
