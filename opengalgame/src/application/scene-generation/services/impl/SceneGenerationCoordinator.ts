import type {
  SceneGenerationScopeDTO,
  SceneGenerationThreadDTO
} from '../../dto/SceneGenerationDTO'
import type {
  SceneGenerationExecution,
  SceneGenerationRuntime,
  SceneGenerationWorkflowOutcome,
  SceneGenerationWorkspace
} from '../../models/SceneGenerationExecution'
import type { SceneArtifactGateway } from '../../ports/SceneArtifactGateway'
import type { SceneGenerationWorkflow } from '../../ports/SceneGenerationWorkflow'
import type { SceneInputGateway } from '../../ports/SceneInputGateway'
import type { SceneVersionGateway } from '../../ports/SceneVersionGateway'
import type { SceneGenerationProgressVO } from '../../vo/SceneGenerationVO'
import type {
  SceneGenerationRenderProgressEventVO,
  SceneGenerationTimelineEntryVO
} from '../../vo/SceneGenerationRenderVO'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { SceneGenerationVersionConflict } from '../../policies/SceneGenerationVersionConflict'
import type { SceneGenerationDomainService } from '@domain/scene-generation/services/SceneGenerationDomainService'
import {
  renderStage,
  renderStageMessage,
  toRenderProgressEvent
} from '../../mapping/SceneGenerationRenderProjection'
import { completedExecution, requireAcceptable } from './SceneGenerationApplicationRules'
import { safeFailure } from './SceneGenerationFailureFacts'
import { operationKey, threadKey } from '../../policies/SceneGenerationIdempotency'
import { isTerminal, toStatusVO } from '../../mapping/SceneGenerationViewMapper'
import { progressMessageOf } from '../../mapping/SceneGenerationStateProjection'

import type { SceneGenerationExecutionRepository } from '../../ports/SceneGenerationExecutionRepository'
import type { SceneGenerationHistoryReader } from '../../ports/SceneGenerationHistoryReader'
import type { SceneGenerationMemoryGateway } from '../../ports/SceneGenerationMemoryGateway'
import type { SceneGenerationWorkflowControl } from '../../ports/SceneGenerationWorkflowControl'
import type { SceneCandidatePreviewGateway } from '../../ports/SceneCandidatePreviewGateway'
import type { SceneGenerationWorkspaceGateway } from '../../ports/SceneGenerationWorkspaceGateway'

/**
 * 后台任务边界的操作身份。只用于日志关联操作，不参与调度、持久化或诊断编号计算。
 */
export type SceneGenerationDispatchIdentity = {
  readonly operationId: string
  readonly projectId: string
}

export interface SceneGenerationDependencies {
  readonly domain?: SceneGenerationDomainService
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

export class SceneGenerationCoordinator {
  readonly activeExecutions = new Map<string, ActiveSceneGeneration>()
  private readonly serialTails = new Map<string, Promise<void>>()
  /** 注入用例端口、身份、时钟和后台任务出口，不创建任何基础设施实现。 */
  constructor(private readonly deps: SceneGenerationDependencies) {}

  /** 仅串行启动、回复和状态变更，不把模型执行放入队列；失败不阻断后续短操作。 */
  serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.serialTails.get(key) ?? Promise.resolve()).then(operation)
    const tail = result.then(
      () => undefined,
      () => undefined
    )
    this.serialTails.set(key, tail)
    void tail.then(() => {
      if (this.serialTails.get(key) === tail) this.serialTails.delete(key)
    })
    return result
  }

  /**
   * 返回相同请求的操作，拒绝相同标识对应其他请求。
   * @param fingerprint - 不含密钥的请求内容。
   * @returns 已有操作或 null。
   * @throws {AppException} 相同操作标识被用于不同请求。
   */
  async replay(
    scope: SceneGenerationScopeDTO,
    fingerprint: string
  ): Promise<SceneGenerationExecution | null> {
    const previous = await this.deps.executions.readExecution(scope)
    if (previous && previous.fingerprint !== fingerprint)
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '同一操作标识对应的请求内容不一致'
      })
    return previous
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
    requireAcceptable(inspected, await this.deps.versions.inspectBaseline(inspected))
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
    const key = operationKey(scope)
    const listeners = progressListeners.get(key) ?? new Set()
    listeners.add(publish)
    progressListeners.set(key, listeners)
    return () => {
      listeners.delete(publish)
      if (listeners.size === 0) progressListeners.delete(key)
    }
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
    this.deps.dispatch(() => this.executeGeneration(active, workflowExecution, restore), {
      operationId: execution.operationId,
      projectId: execution.projectId
    })
  }

  /**
   * 协调候选工作区、工作流、真实读取、提交及事务失败恢复；等待不持有执行预算或作品锁。
   * @param active - 当前操作及直接取消信号。
   * @throws {AppException} 执行失败，后续清理或回退失败同时保留在 cause。
   */
  private async executeGeneration(
    active: ActiveSceneGeneration,
    workflowExecution: (runtime: SceneGenerationRuntime) => Promise<SceneGenerationWorkflowOutcome>,
    restore: boolean
  ): Promise<void> {
    const startedAt = this.deps.now()
    const previousElapsed = active.execution.budget.activeElapsedMs
    const signal = active.controller.signal
    try {
      signal.throwIfAborted()
      if (restore) {
        const inspected = await this.requireCurrentBaseline(active.execution)
        await this.updateExecution(active, { source: inspected.source })
      }
      // 进入 running 时显式清空上一轮人工交互，避免继续运行时携带过期的审阅入口。
      await this.updateExecution(active, {
        state: 'running',
        step: 'preparing',
        interaction: undefined
      })
      let workspace: SceneGenerationWorkspace
      let addedRevision: string | undefined
      const repairInput = active.execution.repairSource
      if (repairInput && !active.execution.candidateSnapshotId) {
        const materialized = await this.deps.workspace.materializeRepairInput(
          active.execution,
          repairInput
        )
        workspace = materialized
        addedRevision = materialized.candidateSnapshotId
      } else if (restore) {
        const restored = await this.deps.workspace.restoreWorkspace(
          active.execution,
          active.execution.candidateSnapshotId
        )
        workspace = restored
        addedRevision = restored.candidateSnapshotId
      } else {
        workspace = await this.deps.workspace.createWorkspace(active.execution)
      }
      await this.updateExecution(active, {
        workspace: {
          workspaceId: workspace.workspaceId,
          rootDirectory: workspace.rootDirectory,
          sceneDirectory: workspace.sceneDirectory
        },
        ...(repairInput && addedRevision
          ? { repairInputSnapshotId: addedRevision, mode: 'repair' as const }
          : addedRevision
            ? { candidateSnapshotId: addedRevision }
            : {})
      })
      const outcome = await workflowExecution({
        execution: structuredClone(active.execution),
        signal,
        userAbortSignal: active.controller.signal,
        activeTimeoutSignal: AbortSignal.any([]),
        publishProgress: async (progress) => {
          if (isTerminal(active.execution)) return structuredClone(active.execution)
          // 终态进度事件不带业务 step，表示工作流已结算的终态预算。
          const settled = isTerminal(active.execution)
          const terminalProgress = progress.step === undefined
          const { artifactValidation, ...rest } = progress
          await this.updateExecution(active, {
            ...rest,
            ...(artifactValidation ? { artifactValidation } : {}),
            budget: retainedBudget(active.execution.budget, {
              ...progress.budget,
              // 终态进度携带工作流结算后的预算，检查点与执行记录必须使用同一份。
              activeElapsedMs:
                terminalProgress && !settled
                  ? progress.budget.activeElapsedMs
                  : settled
                    ? active.execution.budget.activeElapsedMs
                    : previousElapsed + this.deps.now() - startedAt
            })
          })
          return structuredClone(active.execution)
        },
        recordCandidateRevision: async (revision) => {
          // 候选已写入的事实不能因取消结算先到达而丢失。
          await this.updateExecution(active, {
            candidateSnapshotId: revision.candidateSnapshotId
          })
          return structuredClone(active.execution)
        },
        recordFailure: async (failure) => {
          // 先落失败事实，终态阶段由工作流在副作用结算后统一发布。
          await this.updateExecution(active, { failure })
          return structuredClone(active.execution)
        }
      })
      signal.throwIfAborted()
      await this.updateExecution(active, {
        checkpointId: outcome.checkpointId,
        ...(active.execution.repairSource && !active.execution.checkpointId
          ? {}
          : { candidateSnapshotId: outcome.candidateSnapshotId }),
        budget: retainedBudget(active.execution.budget, {
          ...outcome.budget,
          activeElapsedMs: previousElapsed + this.deps.now() - startedAt
        }),
        live: undefined,
        pendingReply: undefined,
        interaction: undefined,
        forkRequest: undefined
      })
      const unsafeInterrupt =
        outcome.state === 'interrupted' &&
        (outcome.interruptReason === 'commitUnknown' ||
          outcome.interruptReason === 'candidateConflict')
      if (unsafeInterrupt) {
        await this.updateExecution(active, {
          state: 'interrupted',
          interruptReason: outcome.interruptReason
        })
      } else if (active.execution.pauseRequested || outcome.state === 'interrupted') {
        const paused =
          active.execution.pauseRequested === true ||
          (outcome.state === 'interrupted' && outcome.interruptReason === 'paused')
        await this.updateExecution(active, {
          state: 'interrupted',
          ...(paused ? { interruptReason: 'paused' as const } : {}),
          ...(outcome.state === 'waiting'
            ? { interaction: outcome.interaction, step: undefined }
            : {})
        })
      } else if (outcome.state === 'waiting') {
        await this.updateExecution(active, {
          state: 'waiting',
          step: undefined,
          interaction: outcome.interaction
        })
      } else {
        await this.commitGeneration(active, signal)
      }
    } catch (error) {
      if (isTerminal(active.execution)) throw error
      await this.recoverFailure(active, error, active.controller.signal.aborted, true)
    } finally {
      this.activeExecutions.delete(operationKey(active.execution))
    }
  }

  /**
   * 重读候选并由领域校验；提交端口在短写入边界再次调用同一领域规则。
   * @param signal - 包含取消与剩余时限的信号。
   * @throws {AppException} 候选不可接受、当前基线变化或正式提交失败。
   */
  private async commitGeneration(
    active: ActiveSceneGeneration,
    signal: AbortSignal
  ): Promise<void> {
    await this.updateExecution(active, { step: 'reading' })
    const candidate = await this.deps.artifacts.readCandidate(
      active.execution,
      active.execution.candidateSnapshotId!
    )
    signal.throwIfAborted()
    await this.updateExecution(active, { step: 'validating' })
    const facts = await this.deps.versions.inspectBaseline(active.execution)
    const report = requireAcceptable(active.execution, facts, candidate)
    const preview = { ...candidate.preview, validationReport: report }
    await this.updateExecution(active, { preview, state: 'committing', step: 'committing' })
    signal.throwIfAborted()
    const commit = await this.deps.versions.commitCandidate(
      active.execution,
      candidate,
      (currentFacts) => {
        signal.throwIfAborted()
        requireAcceptable(active.execution, currentFacts, candidate)
      }
    )
    await this.completeExecution(active, commit.commitId)
  }

  /**
   * 先查询本操作提交事实，再选择确认成功、受控回退或清理；结果不明保留候选。
   * @param originalError - 本次失败或取消原因。
   * @param cancelled - 是否由用户取消。
   * @param serialized - 是否需要排入短串行段，外层已经持有队列时直接写入。
   * @throws {AppException} 原始失败及恢复失败保留为 AggregateError；正常取消不抛错。
   */
  async recoverFailure(
    active: ActiveSceneGeneration,
    originalError: unknown,
    cancelled: boolean,
    serialized: boolean
  ): Promise<void> {
    const persist = async (
      patch: Partial<SceneGenerationExecution>
    ): Promise<SceneGenerationExecution> => {
      if (serialized) {
        await this.updateExecution(active, patch)
        return active.execution
      }
      const updated = { ...active.execution, ...patch, sequence: active.execution.sequence + 1 }
      active.execution = (await this.writeExecution(updated)).execution
      return active.execution
    }
    let commitUnknown = false
    let candidateConflict = false
    try {
      const commit = await this.deps.versions.readOperationCommit(active.execution)
      if (commit.state === 'committed') {
        await this.completeExecution(active, commit.commitId, persist)
        return
      }
      if (commit.state === 'unknown') {
        await persist({
          state: 'interrupted',
          interruptReason: 'commitUnknown',
          failure: safeFailure(originalError, candidateFacts(active.execution)),
          live: undefined,
          requiresCleanup: true,
          cancellationRequested: cancelled
        })
        commitUnknown = true
      } else if (
        commit.state === 'notCommitted' &&
        !cancelled &&
        originalError instanceof SceneGenerationVersionConflict &&
        active.execution.candidateSnapshotId
      ) {
        await persist({
          state: 'interrupted',
          interruptReason: 'candidateConflict',
          failure: safeFailure(originalError, candidateFacts(active.execution)),
          live: undefined,
          requiresCleanup: false
        })
        candidateConflict = true
      } else {
        if (commit.state === 'rollbackRequired') {
          await persist({ step: 'rollingBack' })
          const rollback = await this.deps.versions.rollbackCandidate(
            active.execution,
            commit.commitId
          )
          await persist(rollback)
        }
        await this.deps.workspace.discardWorkspace(active.execution)
        await persist({
          state: cancelled ? 'cancelled' : 'failed',
          step: undefined,
          interaction: undefined,
          pendingReply: undefined,
          live: undefined,
          failure: cancelled
            ? undefined
            : safeFailure(originalError, candidateFacts(active.execution)),
          requiresCleanup: false,
          cancellationRequested: cancelled
        })
      }
    } catch (recoveryError) {
      const failures = [originalError, recoveryError]
      if (active.execution.state !== 'interrupted' && !isTerminal(active.execution)) {
        try {
          await persist({
            state: 'interrupted',
            failure: safeFailure(originalError, candidateFacts(active.execution)),
            live: undefined,
            requiresCleanup: true,
            cancellationRequested: cancelled
          })
        } catch (recordingError) {
          failures.push(recordingError)
        }
      }
      throw new AppException({
        code: ErrorCodes.internalError,
        msg: '场景生成未完整结束，请核对并恢复该操作',
        cause: new AggregateError(failures, '场景生成与恢复失败')
      })
    }
    if (commitUnknown)
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '作品提交结果尚未查明，已保留候选与恢复记录',
        cause: originalError
      })
    if (candidateConflict || !cancelled) throw originalError
  }

  /**
   * 将可靠提交结果持久记录后发布成功，不因预览页后续展示失败回退已保存作品。
   * @param persist - 已持有短串行段时提供直接持久记录，默认排入短串行段。
   * @throws {AppException} 成功结果持久记录失败，恢复须先查询已有提交。
   */
  async completeExecution(
    active: ActiveSceneGeneration,
    commitId: string,
    persist: (
      patch: Partial<SceneGenerationExecution>
    ) => Promise<SceneGenerationExecution> = async (patch) => {
      await this.updateExecution(active, patch)
      return active.execution
    }
  ): Promise<void> {
    const completed = completedExecution(active.execution, commitId)
    let cleanupFailure: AppException | undefined
    try {
      await this.deps.workspace.discardWorkspace(active.execution)
    } catch (cleanupError) {
      cleanupFailure = new AppException({
        code: ErrorCodes.internalError,
        msg: '作品已保存，但候选工作区清理未完成',
        cause: cleanupError
      })
    }
    const updated = {
      ...completed,
      workspace: cleanupFailure ? completed.workspace : undefined,
      workspaceCleanupPending: Boolean(cleanupFailure),
      failure: cleanupFailure ? safeFailure(cleanupFailure) : undefined
    }
    active.execution = await persist(updated)
    if (cleanupFailure) throw cleanupFailure
  }

  /**
   * 在线程短串行段内持久更新进度序号，随后通知调用方。
   * @throws {AppException} 状态持久记录失败。
   */
  private updateExecution(
    active: ActiveSceneGeneration,
    patch: Partial<SceneGenerationExecution>
  ): Promise<void> {
    return this.serialize(threadKey(active.execution), async () => {
      if (isTerminal(active.execution) && patch.state && patch.state !== active.execution.state)
        return
      const previousSnapshot = active.execution.candidateSnapshotId
      const previousCheckpoint = active.execution.checkpointId
      const nextSnapshot = patch.candidateSnapshotId
      const nextCheckpoint = patch.checkpointId
      const updated = { ...active.execution, ...patch, sequence: active.execution.sequence + 1 }
      const recorded = (await this.writeExecution(updated)).execution
      active.execution = recorded
      if (
        previousSnapshot &&
        nextSnapshot &&
        previousCheckpoint &&
        nextCheckpoint &&
        nextSnapshot !== previousSnapshot &&
        nextCheckpoint !== previousCheckpoint
      )
        await this.deps.candidatePreview?.invalidateCandidatePreviewSessions({
          projectId: recorded.projectId,
          sceneId: recorded.sceneId,
          operationId: recorded.operationId,
          candidateSnapshotId: previousSnapshot
        })
    })
  }

  /**
   * 持久写入状态后发布安全阶段文案，通知适配必须自行隔离故障。
   * 只有已暂停且有检查点时才读取 canContinue；读取失败不撤销已写入记录，也不发布未知事件。
   * @throws {AppException} 操作状态写入失败。
   */
  async writeExecution(
    execution: SceneGenerationExecution
  ): Promise<{ execution: SceneGenerationExecution; canContinue: boolean | undefined }> {
    const pending = appendTimeline(execution, this.deps.now())
    const recorded = await this.deps.executions.writeExecution(pending)
    this.deps.publishProgress({
      ...toStatusVO(recorded, this.activeExecutions.has(operationKey(recorded))),
      message: progressMessageOf(recorded.state, recorded.step)
    })
    const canContinue = await renderCanContinue(this.deps, recorded)
    if (canContinue !== undefined) {
      for (const listener of progressListeners.get(operationKey(recorded)) ?? []) {
        listener(toRenderProgressEvent(recorded, canContinue))
      }
    }
    return { execution: recorded, canContinue }
  }
}

/**
 * 可恢复中断才读取检查点。取消、失败和提交不明直接不可继续。
 * 读取失败返回 undefined，不能用 false 表示未知。
 */
async function renderCanContinue(
  deps: SceneGenerationDependencies,
  execution: SceneGenerationExecution
): Promise<boolean | undefined> {
  if (
    execution.state !== 'interrupted' ||
    execution.interruptReason === 'commitUnknown' ||
    execution.interruptReason === 'candidateConflict' ||
    !execution.checkpointId
  ) {
    return false
  }
  try {
    return await checkpointCanContinue(deps, execution)
  } catch (error) {
    console.warn('暂停进度的检查点继续资格未能读取', {
      errorCode: error instanceof AppException ? error.code : ErrorCodes.internalError
    })
    return undefined
  }
}

/**
 * 只读取检查点视图的 canContinue。没有检查点时为 false，不把内部文档交给渲染。
 * 状态查询仍把读取失败原样抛出。
 */
export async function checkpointCanContinue(
  deps: SceneGenerationDependencies,
  execution: SceneGenerationExecution
): Promise<boolean> {
  if (!execution.checkpointId) return false
  const checkpoint = await deps.history.readCheckpoint({
    projectId: execution.projectId,
    sceneId: execution.sceneId,
    threadId: execution.threadId,
    branchId: execution.branchId,
    checkpointId: execution.checkpointId
  })
  return checkpoint.view.canContinue
}

const progressListeners = new Map<
  string,
  Set<(event: SceneGenerationRenderProgressEventVO) => void>
>()

/** 失败时仍可读的候选只给只读授权；没有候选修订时不补造事实。 */
function candidateFacts(
  execution: SceneGenerationExecution
): { candidateSnapshotId: string; previewAuthorization: 'readOnly' } | undefined {
  return execution.candidateSnapshotId
    ? { candidateSnapshotId: execution.candidateSnapshotId, previewAuthorization: 'readOnly' }
    : undefined
}

function retainedBudget(
  previous: SceneGenerationExecution['budget'],
  incoming: SceneGenerationExecution['budget']
): SceneGenerationExecution['budget'] {
  const inputTokens = incoming.inputTokens ?? previous.inputTokens
  const outputTokens = incoming.outputTokens ?? previous.outputTokens
  const totalTokens =
    incoming.totalTokens ??
    (inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens
      : previous.totalTokens)
  return {
    ...previous,
    ...incoming,
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    tokenLimit:
      incoming.tokenLimit === undefined ? (previous.tokenLimit ?? null) : incoming.tokenLimit
  }
}

function appendTimeline(
  execution: SceneGenerationExecution,
  now: number
): SceneGenerationExecution {
  const stage = renderStage(execution)
  const kind: SceneGenerationTimelineEntryVO['kind'] =
    execution.failure ||
    execution.interruptReason === 'commitUnknown' ||
    execution.interruptReason === 'candidateConflict'
      ? 'failure'
      : execution.interaction
        ? execution.interaction.kind === 'decision'
          ? 'decision'
          : 'interaction'
        : 'stage'
  const message = renderStageMessage(stage, execution.interruptReason)
  const previous = execution.timeline ?? []
  const last = previous.at(-1)
  if (
    last &&
    last.kind === kind &&
    last.stage === stage &&
    last.message === message &&
    last.interactionId === execution.interaction?.interactionId &&
    last.candidateSnapshotId === execution.candidateSnapshotId
  ) {
    return execution
  }
  const entry: SceneGenerationTimelineEntryVO = {
    entryId: `${execution.operationId}:${execution.sequence}`,
    sequence: execution.sequence,
    createdAt: new Date(now).toISOString(),
    kind,
    stage,
    message,
    ...(execution.interaction ? { interactionId: execution.interaction.interactionId } : {}),
    ...(execution.candidateSnapshotId ? { candidateSnapshotId: execution.candidateSnapshotId } : {})
  }
  const important = previous.filter((item) => item.kind !== 'stage')
  const stages = previous.filter((item) => item.kind === 'stage')
  return { ...execution, timeline: [...important, ...stages.slice(-16), entry].slice(-64) }
}
