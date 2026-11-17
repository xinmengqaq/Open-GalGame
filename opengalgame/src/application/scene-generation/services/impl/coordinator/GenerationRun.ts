import type { SceneGenerationScopeDTO } from '@application/scene-generation/dto/SceneGenerationDTO'
import type {
  SceneGenerationExecution,
  SceneGenerationRuntime,
  SceneGenerationWorkflowOutcome,
  SceneGenerationWorkspace
} from '@application/scene-generation/models/SceneGenerationExecution'
import {
  isTerminal,
  toStatusVO
} from '@application/scene-generation/mapping/SceneGenerationViewMapper'
import {
  progressMessageOf
} from '@application/scene-generation/mapping/SceneGenerationStateProjection'
import {
  renderStage,
  renderStageMessage,
  toRenderProgressEvent
} from '@application/scene-generation/mapping/SceneGenerationRenderProjection'
import {
  operationKey,
  threadKey
} from '@application/scene-generation/policies/SceneGenerationIdempotency'
import type {
  SceneGenerationRenderProgressEventVO,
  SceneGenerationTimelineEntryVO
} from '@application/scene-generation/vo/SceneGenerationRenderVO'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type {
  ActiveSceneGeneration,
  SceneGenerationDependencies
} from '../SceneGenerationCoordinator'
import type { GenerationCommit } from './GenerationCommit'
import type { GenerationRecovery } from './GenerationRecovery'
import type { ExecutionSerialQueue } from './ExecutionSerialQueue'

/** Coordinator 提供给运行编排的稳定事实与公开编排面。 */
export interface GenerationRunHost {
  readonly deps: SceneGenerationDependencies
  isActive(execution: SceneGenerationExecution): boolean
  release(execution: SceneGenerationExecution): void
  requireCurrentBaseline(
    execution: SceneGenerationExecution
  ): Promise<SceneGenerationExecution>
}

/** 提交与恢复协作者共用的持久化边界，执行状态只由运行编排原地推进。 */
export interface GenerationRuntimePort {
  readonly deps: SceneGenerationDependencies
  updateExecution(
    active: ActiveSceneGeneration,
    patch: Partial<SceneGenerationExecution>
  ): Promise<void>
  writeExecution(execution: SceneGenerationExecution): Promise<{
    execution: SceneGenerationExecution
    canContinue: boolean | undefined
  }>
}

/**
 * 协调候选工作区、工作流、真实读取、提交及事务失败恢复；等待不持有执行预算或作品锁。
 * 时间线与状态写入归这里，活动操作表仍由 Coordinator 持有。
 */
export class GenerationRun implements GenerationRuntimePort {
  readonly deps: SceneGenerationDependencies

  constructor(
    private readonly host: GenerationRunHost,
    private readonly queue: ExecutionSerialQueue,
    private readonly commit: GenerationCommit,
    private readonly recovery: GenerationRecovery
  ) {
    this.deps = host.deps
  }

  /**
   * @param active - 当前操作及直接取消信号。
   * @throws {AppException} 执行失败，后续清理或回退失败同时保留在 cause。
   */
  async execute(
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
        const inspected = await this.host.requireCurrentBaseline(active.execution)
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
      } else if (restore || active.execution.candidateSnapshotId) {
        // 恢复标记来自持久记录时，工作区可能已随重启丢失；已有候选修订仍按不可变修订恢复，
        // 不能新建同名目录，也不能把未确认写入当作可继续的历史。
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
        await this.commit.commitGeneration(this, active, signal)
      }
    } catch (error) {
      if (isTerminal(active.execution)) throw error
      await this.recovery.recoverFailure(
        this,
        active,
        error,
        active.controller.signal.aborted,
        true
      )
    } finally {
      this.host.release(active.execution)
    }
  }

  /**
   * 在线程短串行段内持久更新进度序号，随后通知调用方。
   * @throws {AppException} 状态持久记录失败。
   */
  updateExecution(
    active: ActiveSceneGeneration,
    patch: Partial<SceneGenerationExecution>
  ): Promise<void> {
    return this.queue.serialize(threadKey(active.execution), async () => {
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
      ...toStatusVO(recorded, this.host.isActive(recorded)),
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
    // Node 后台没有注入 logger；保留 console 作为明确例外，读取失败仍返回 undefined。
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

/**
 * 进度监听按操作跨协调器实例共享；模型执行、提交和恢复的写入都通知同一订阅表。
 */
const progressListeners = new Map<
  string,
  Set<(event: SceneGenerationRenderProgressEventVO) => void>
>()

/** 订阅当前操作的安全进度；退订只移除本次回调。 */
export function subscribeProgress(
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
