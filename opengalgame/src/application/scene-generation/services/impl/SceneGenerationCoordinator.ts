import type {
  SceneGenerationScopeDTO,
  SceneGenerationThreadDTO
} from '../../dto/SceneGenerationDTO'
import type {
  SceneGenerationExecution,
  SceneGenerationRuntime,
  SceneGenerationWorkflowOutcome
} from '../../models/SceneGenerationExecution'
import type { SceneArtifactGateway } from '../../ports/SceneArtifactGateway'
import type { SceneGenerationWorkflow } from '../../ports/SceneGenerationWorkflow'
import type { SceneInputGateway } from '../../ports/SceneInputGateway'
import type { SceneVersionGateway } from '../../ports/SceneVersionGateway'
import type { SceneGenerationProgressVO } from '../../vo/SceneGenerationVO'
import type { SceneGenerationRenderProgressEventVO } from '../../vo/SceneGenerationRenderVO'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { SceneGenerationDomainService } from '@domain/scene-generation/services/SceneGenerationDomainService'
import { requireAcceptable } from './SceneGenerationApplicationRules'
import { operationKey, threadKey } from '../../policies/SceneGenerationIdempotency'

import type { SceneGenerationExecutionRepository } from '../../ports/SceneGenerationExecutionRepository'
import type { SceneGenerationHistoryReader } from '../../ports/SceneGenerationHistoryReader'
import type { SceneGenerationMemoryGateway } from '../../ports/SceneGenerationMemoryGateway'
import type { SceneGenerationWorkflowControl } from '../../ports/SceneGenerationWorkflowControl'
import type { SceneCandidatePreviewGateway } from '../../ports/SceneCandidatePreviewGateway'
import type { SceneGenerationWorkspaceGateway } from '../../ports/SceneGenerationWorkspaceGateway'
import { ExecutionSerialQueue } from './coordinator/ExecutionSerialQueue'
import { GenerationRun, subscribeProgress } from './coordinator/GenerationRun'
import { GenerationCommit } from './coordinator/GenerationCommit'
import { GenerationRecovery } from './coordinator/GenerationRecovery'

export { checkpointCanContinue } from './coordinator/GenerationRun'

/**
 * 后台任务边界的操作身份。只用于日志关联操作，不参与调度、持久化或诊断编号计算。
 */
export type SceneGenerationDispatchIdentity = {
  readonly operationId: string
  readonly projectId: string
}

export interface SceneGenerationDependencies {
  readonly domain: SceneGenerationDomainService
  readonly input: SceneInputGateway
  readonly workflow: SceneGenerationWorkflow
  readonly executions: SceneGenerationExecutionRepository
  readonly history: SceneGenerationHistoryReader
  readonly memory: SceneGenerationMemoryGateway
  readonly workspace: SceneGenerationWorkspaceGateway
  readonly artifacts: SceneArtifactGateway
  readonly versions: SceneVersionGateway
  readonly workflowControl?: SceneGenerationWorkflowControl
  readonly candidatePreview?: SceneCandidatePreviewGateway
  readonly nextId: () => string
  readonly now: () => number
  /**
   * 将执行排入后台任务边界；调度本身不抛错，边界捕获、记录任务最终异常。
   * @param execution - 应用事务编排，返回的拒绝由任务边界接收。
   * @param identity - 本次操作身份，供边界记录关联日志。
   */
  readonly dispatch: (
    execution: () => Promise<void>,
    identity: SceneGenerationDispatchIdentity
  ) => void
  /**
   * 发布已经持久记录的安全进度；通知故障由通知边界隔离，不影响作品提交。
   * @param progress - 阶段与业务状态，不含诊断日志。
   */
  readonly publishProgress: (progress: SceneGenerationProgressVO) => void
}

export interface ActiveSceneGeneration {
  execution: SceneGenerationExecution
  readonly controller: AbortController
}

/**
 * 场景生成薄编排：保留活动操作表与公开编排面，
 * 串行/幂等、运行时间线、提交决策、失败恢复分别委托对应协作者。
 */
export class SceneGenerationCoordinator {
  readonly activeExecutions = new Map<string, ActiveSceneGeneration>()
  private readonly queue: ExecutionSerialQueue
  private readonly run: GenerationRun
  private readonly commit: GenerationCommit
  private readonly recovery: GenerationRecovery

  /** 注入用例端口、身份、时钟和后台任务出口，不创建任何基础设施实现。 */
  constructor(private readonly deps: SceneGenerationDependencies) {
    this.queue = new ExecutionSerialQueue(deps.executions)
    this.commit = new GenerationCommit()
    this.recovery = new GenerationRecovery(this.commit)
    this.run = new GenerationRun(
      {
        deps,
        /** 活动操作仍由本协调器持有；运行编排只查询和释放。 */
        isActive: (execution) => this.activeExecutions.has(operationKey(execution)),
        release: (execution) => {
          this.activeExecutions.delete(operationKey(execution))
        },
        requireCurrentBaseline: (execution) => this.requireCurrentBaseline(execution)
      },
      this.queue,
      this.commit,
      this.recovery
    )
  }

  /** 仅串行启动、回复和状态变更，不把模型执行放入队列；失败不阻断后续短操作。 */
  serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    return this.queue.serialize(key, operation)
  }

  /**
   * 返回相同请求的操作，拒绝相同标识对应其他请求。
   * @param fingerprint - 不含密钥的请求内容。
   * @returns 已有操作或 null。
   * @throws {AppException} 相同操作标识被用于不同请求。
   */
  replay(
    scope: SceneGenerationScopeDTO,
    fingerprint: string
  ): Promise<SceneGenerationExecution | null> {
    return this.queue.replay(scope, fingerprint)
  }

  /**
   * 要求操作存在且属于调用方场景。
   * @throws {AppException} 操作不存在。
   */
  async requireExecution(scope: SceneGenerationScopeDTO): Promise<SceneGenerationExecution> {
    const execution = await this.deps.executions.readExecution(scope)
    if (!execution)
      throw new AppException({ code: ErrorCodes.invalidRequest, msg: '该场景生成操作不存在' })
    return execution
  }

  /**
   * 要求线程没有尚未结束的操作，保留等待和待恢复操作的逻辑位置。
   * @throws {AppException} 线程尚有活动操作。
   */
  async requireIdleThread(scope: SceneGenerationThreadDTO): Promise<void> {
    const active = [...this.activeExecutions.values()].some(
      (operation) => threadKey(operation.execution) === threadKey(scope)
    )
    if (active || (await this.deps.executions.findActiveExecution(scope)))
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '该创作对话仍有未结束操作，请先回复、恢复或取消'
      })
  }

  /**
   * 取得新版本事实并由领域决定是否允许继续覆盖，不持有作品锁。
   * @throws {AppException} 工程身份、当前锁定或基线不允许覆盖。
   */
  async requireCurrentBaseline(
    execution: SceneGenerationExecution
  ): Promise<SceneGenerationExecution> {
    const source = await this.deps.input.locateScene({
      projectId: execution.projectId,
      sceneId: execution.sceneId
    })
    const inspected = { ...execution, source }
    requireAcceptable(
      inspected,
      await this.deps.versions.inspectBaseline(inspected),
      undefined,
      this.deps.domain
    )
    return inspected
  }

  /**
   * 持久暂停意图已经写入后，通知工作流在安全检查点停止。
   * 没有活动工作流时不伪造中断。
   */
  async requestPause(execution: SceneGenerationExecution): Promise<void> {
    await this.deps.workflowControl?.requestPauseAtSafeCheckpoint(execution)
  }

  subscribeRenderProgress(
    scope: SceneGenerationScopeDTO,
    publish: (event: SceneGenerationRenderProgressEventVO) => void
  ): () => void {
    return subscribeProgress(scope, publish)
  }

  /**
   * @param cancelled - 是否直接结束已经接受的丢弃回复。
   */
  startExecution(
    execution: SceneGenerationExecution,
    workflowExecution: (runtime: SceneGenerationRuntime) => Promise<SceneGenerationWorkflowOutcome>,
    restore: boolean,
    cancelled = false
  ): void {
    const active: ActiveSceneGeneration = { execution, controller: new AbortController() }
    if (cancelled) active.controller.abort()
    this.activeExecutions.set(operationKey(execution), active)
    this.deps.dispatch(() => this.run.execute(active, workflowExecution, restore), {
      operationId: execution.operationId,
      projectId: execution.projectId
    })
  }

  /**
   * 持久写入状态并发布安全阶段文案。
   * @throws {AppException} 操作状态写入失败。
   */
  writeExecution(
    execution: SceneGenerationExecution
  ): Promise<{ execution: SceneGenerationExecution; canContinue: boolean | undefined }> {
    return this.run.writeExecution(execution)
  }

  /**
   * 将可靠提交结果持久记录后发布成功，不因预览页后续展示失败回退已保存作品。
   * @param persist - 已持有短串行段时提供直接持久记录，默认排入短串行段。
   * @throws {AppException} 成功结果持久记录失败，恢复须先查询已有提交。
   */
  completeExecution(
    active: ActiveSceneGeneration,
    commitId: string,
    persist: (
      patch: Partial<SceneGenerationExecution>
    ) => Promise<SceneGenerationExecution> = async (patch) => {
      await this.run.updateExecution(active, patch)
      return active.execution
    }
  ): Promise<void> {
    return this.commit.completeExecution(this.run, active, commitId, persist)
  }

  /**
   * 先查询本操作提交事实，再选择确认成功、受控回退或清理；结果不明保留候选。
   * @param originalError - 本次失败或取消原因。
   * @param cancelled - 是否由用户取消。
   * @param serialized - 是否需要排入短串行段，外层已经持有队列时直接写入。
   * @throws {AppException} 原始失败及恢复失败保留为 AggregateError；正常取消不抛错。
   */
  recoverFailure(
    active: ActiveSceneGeneration,
    originalError: unknown,
    cancelled: boolean,
    serialized: boolean
  ): Promise<void> {
    return this.recovery.recoverFailure(this.run, active, originalError, cancelled, serialized)
  }
}
