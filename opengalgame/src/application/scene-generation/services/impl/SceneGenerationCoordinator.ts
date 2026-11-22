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
import { FailureReasons } from '@common/errors/FailureReasons'
import type { SceneGenerationDomainService } from '@domain/scene-generation/services/SceneGenerationDomainService'
import {
  forkSourceRecordReason,
  type SceneGenerationForkBoundary
} from '../../policies/SceneGenerationForkBoundary'
import { requireAcceptable } from './SceneGenerationApplicationRules'
import { isTerminal } from '../../mapping/SceneGenerationViewMapper'
import { operationKey, threadKey } from '../../policies/SceneGenerationIdempotency'

import type { SceneGenerationExecutionRepository } from '../../ports/SceneGenerationExecutionRepository'
import type { SceneGenerationHistoryReader } from '../../ports/SceneGenerationHistoryReader'
import type { SceneGenerationMemoryGateway } from '../../ports/SceneGenerationMemoryGateway'
import type { SceneGenerationWorkflowControl } from '../../ports/SceneGenerationWorkflowControl'
import type { SceneCandidatePreviewGateway } from '../../ports/SceneCandidatePreviewGateway'
import type { SceneGenerationWorkspaceGateway } from '../../ports/SceneGenerationWorkspaceGateway'
import type { SceneGenerationWriteRecovery } from '../../ports/SceneGenerationWriteRecovery'
import type { SceneGenerationForkSourceEvidence } from '../../ports/SceneGenerationForkSourceEvidence'
import { ExecutionSerialQueue } from './coordinator/ExecutionSerialQueue'
import { GenerationRun, subscribeProgress } from './coordinator/GenerationRun'
import { GenerationCommit } from './coordinator/GenerationCommit'
import { GenerationRecovery } from './coordinator/GenerationRecovery'

export { checkpointCanContinue } from './coordinator/GenerationRun'

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
  /** 恢复运行前按账本、修订归属和实际工作区证明候选写入。 */
  readonly writeRecovery: SceneGenerationWriteRecovery
  /**
   * 分叉来源不可变证据。未装配时应用拒绝创建或重开分叉；
   * 不影响普通生成、修复与恢复。
   */
  readonly forkSourceEvidence?: SceneGenerationForkSourceEvidence
  /**
   * 可信装配给出的活跃执行期限（毫秒）。不进入请求 DTO、IPC 或操作指纹；
   * 省略表示本次装配不安排定时中止，预算边界检查仍然生效。
   */
  readonly activeLimitMs?: number
  readonly workflowControl?: SceneGenerationWorkflowControl
  readonly candidatePreview?: SceneCandidatePreviewGateway
  readonly nextId: () => string
  readonly now: () => number
  readonly dispatch: (
    execution: () => Promise<void>,
    identity: SceneGenerationDispatchIdentity
  ) => void
  readonly publishProgress: (progress: SceneGenerationProgressVO) => void
}

export interface ActiveSceneGeneration {
  execution: SceneGenerationExecution
  readonly controller: AbortController
}

export class SceneGenerationCoordinator {
  readonly activeExecutions = new Map<string, ActiveSceneGeneration>()
  private readonly queue: ExecutionSerialQueue
  private readonly run: GenerationRun
  private readonly commit: GenerationCommit
  private readonly recovery: GenerationRecovery

  constructor(private readonly deps: SceneGenerationDependencies) {
    this.queue = new ExecutionSerialQueue(deps.executions)
    this.commit = new GenerationCommit()
    this.recovery = new GenerationRecovery(this.commit)
    this.run = new GenerationRun(
      {
        deps,
        isActive: (execution) => this.activeExecutions.has(operationKey(execution)),
        owns: (active) => this.activeExecutions.get(operationKey(active.execution)) === active,
        release: (active) => {
          const key = operationKey(active.execution)
          // 只有当前这一份运行能移除自己；旧运行不能删掉新代次的活动记录。
          if (this.activeExecutions.get(key) === active) this.activeExecutions.delete(key)
        },
        requireCurrentBaseline: (execution) => this.requireCurrentBaseline(execution)
      },
      this.queue,
      this.commit,
      this.recovery
    )
  }

  serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    return this.queue.serialize(key, operation)
  }

  replay(
    scope: SceneGenerationScopeDTO,
    fingerprint: string
  ): Promise<SceneGenerationExecution | null> {
    return this.queue.replay(scope, fingerprint)
  }

  /**
   * 要求操作存在且属于调用方场景。
   * 只有仓储查询确认记录不存在才带 `sceneGenerationOperationMissing`；
   * 检查点缺失、损坏、身份不符和读取失败不使用该原因。
   * @throws {AppException} 操作不存在。
   */
  async requireExecution(scope: SceneGenerationScopeDTO): Promise<SceneGenerationExecution> {
    const execution = await this.deps.executions.readExecution(scope)
    if (!execution)
      throw new AppException({
        code: ErrorCodes.invalidRequest,
        msg: '该场景生成操作不存在',
        reason: FailureReasons.sceneGenerationOperationMissing
      })
    return execution
  }

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
   * 分叉允许来源停在等待/安全暂停；来源能否复制由历史检查点资格判断。
   * 当前记录必须仍绑定同一检查点与候选，来源自身不能正在执行，线程也不能另有未结束操作。
   * @throws {AppException} 来源记录不可分叉、线程有运行中或其它未结束操作。
   */
  async requireForkableThread(
    boundary: SceneGenerationForkBoundary,
    source: SceneGenerationExecution | null
  ): Promise<void> {
    const recordReason = forkSourceRecordReason(source, boundary)
    if (recordReason !== undefined)
      throw new AppException({ code: ErrorCodes.operationConflict, msg: recordReason })
    const scope: SceneGenerationThreadDTO = {
      projectId: boundary.projectId,
      sceneId: boundary.sceneId,
      threadId: boundary.threadId
    }
    const active = [...this.activeExecutions.values()].some(
      (operation) => threadKey(operation.execution) === threadKey(scope)
    )
    if (active)
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '该创作对话仍有运行中的操作，不能从历史分叉'
      })
    const operations = (
      await this.deps.executions.listSceneExecutions({
        projectId: scope.projectId,
        sceneId: scope.sceneId,
        limit: 100
      })
    ).filter((operation) => operation.threadId === scope.threadId)
    if (
      operations.some(
        (operation) => operation.operationId !== boundary.operationId && !isTerminal(operation)
      )
    )
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '该创作对话仍有其它未结束操作，请先回复、恢复或取消'
      })
  }

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

  async requestPause(execution: SceneGenerationExecution): Promise<void> {
    await this.deps.workflowControl?.requestPauseAtSafeCheckpoint(execution)
  }

  subscribeRenderProgress(
    scope: SceneGenerationScopeDTO,
    publish: (event: SceneGenerationRenderProgressEventVO) => void
  ): () => void {
    return subscribeProgress(scope, publish)
  }

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

  writeExecution(
    execution: SceneGenerationExecution
  ): Promise<{ execution: SceneGenerationExecution; canContinue: boolean | undefined }> {
    return this.run.writeExecution(execution)
  }

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

  recoverFailure(
    active: ActiveSceneGeneration,
    originalError: unknown,
    cancelled: boolean,
    serialized: boolean
  ): Promise<void> {
    return this.recovery.recoverFailure(this.run, active, originalError, cancelled, serialized)
  }
}
