import type { SceneGenerationScopeDTO } from '@application/scene-generation/dto/SceneGenerationDTO'
import type {
  SceneGenerationExecution,
  SceneGenerationPublishedCandidate,
  SceneGenerationRuntime,
  SceneGenerationWorkflowOutcome,
  SceneGenerationWorkflowProgress,
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
import { scheduleLongTimeout } from '@common/longTimeout'
import type {
  SceneGenerationRenderProgressEventVO,
  SceneGenerationTimelineEntryVO
} from '@application/scene-generation/vo/SceneGenerationRenderVO'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { SceneGenerationWriteOutcomeUnknown } from '@application/scene-generation/errors/SceneGenerationWriteOutcomeUnknown'
import { safeFailureWithDiagnosticRef } from '../SceneGenerationFailureFacts'
import type {
  ActiveSceneGeneration,
  SceneGenerationDependencies
} from '../SceneGenerationCoordinator'
import type { GenerationCommit } from './GenerationCommit'
import type { GenerationRecovery } from './GenerationRecovery'
import type { ExecutionSerialQueue } from './ExecutionSerialQueue'

export interface GenerationRunHost {
  readonly deps: SceneGenerationDependencies
  isActive(execution: SceneGenerationExecution): boolean
  /** 当前活动表是否仍持有这一份运行；旧运行不能用同操作的新代次身份写回。 */
  owns(active: ActiveSceneGeneration): boolean
  release(active: ActiveSceneGeneration): void
  requireCurrentBaseline(
    execution: SceneGenerationExecution
  ): Promise<SceneGenerationExecution>
}

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
  /**
   * 提交门：与暂停受理共用同一串行段裁决。已受理暂停优先，保留边界与候选；
   * 否则原子进入 committing，此后到达的暂停只能被拒绝。
   * @returns 是否允许执行不可撤销的正式提交。
   */
  enterCommitGate(
    active: ActiveSceneGeneration,
    preview: SceneGenerationExecution['preview'],
    signal: AbortSignal
  ): Promise<boolean>
  /** 正式作品提交完成后清除可提交结果的暂停边界。 */
  clearPauseBoundary(execution: SceneGenerationExecution): Promise<void>
}

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

  async execute(
    active: ActiveSceneGeneration,
    workflowExecution: (runtime: SceneGenerationRuntime) => Promise<SceneGenerationWorkflowOutcome>,
    restore: boolean
  ): Promise<void> {
    // 迟到的旧运行不能再推进任何持久状态或提交。
    if (!this.host.owns(active)) return
    const startedAt = this.deps.now()
    const previousElapsed = active.execution.budget.activeElapsedMs
    const userSignal = active.controller.signal
    // 活跃期限到期只中止本次执行，不冒充用户取消；恢复边界据用户信号区分终态。
    const timeoutController = new AbortController()
    const cancelActiveTimer =
      this.deps.activeLimitMs === undefined
        ? undefined
        : scheduleLongTimeout(this.deps.activeLimitMs, () => {
            timeoutController.abort(
              new AppException({
                code: ErrorCodes.invalidRequest,
                msg: '活跃执行时间已用尽',
                diagnosticCategory: 'context'
              })
            )
          })
    const signal = AbortSignal.any([userSignal, timeoutController.signal])
    try {
      signal.throwIfAborted()
      if (restore) {
        const inspected = await this.host.requireCurrentBaseline(active.execution)
        await this.updateExecution(active, { source: inspected.source })
      }
      const repairInput = active.execution.repairSource
      // 修复输入已准备好但首个候选写入前中断：先按不可变来源把输入修订写回执行记录，
      // 让写入恢复门把它当作已证明输入而不是未归属候选；证据不足时仍交给恢复门判断。
      let preparedRepairInput =
        repairInput !== undefined && active.execution.candidateSnapshotId === undefined
          ? await this.deps.workspace.proveRepairInput(active.execution, repairInput)
          : undefined
      if (preparedRepairInput !== undefined) {
        await this.updateExecution(active, {
          repairInputSnapshotId: preparedRepairInput.candidateSnapshotId,
          mode: 'repair',
          workspace: {
            workspaceId: preparedRepairInput.workspaceId,
            rootDirectory: preparedRepairInput.rootDirectory,
            sceneDirectory: preparedRepairInput.sceneDirectory
          }
        })
      }
      // 重建或改写工作区之前，先按本操作账本、修订归属和实际工作区证明当前候选。
      // 证据不完整时保留工作区、候选与账本，只进入待核对；不猜测写入结果。
      const writeRecovery = await this.deps.writeRecovery.recoverCandidateWrite(
        active.execution,
        async (candidateSnapshotId) => {
          if (active.execution.candidateSnapshotId === candidateSnapshotId) return
          await this.updateExecution(active, { candidateSnapshotId })
        }
      )
      if (writeRecovery.outcome === 'unprovable') {
        const retainedCandidate =
          writeRecovery.candidateSnapshotId ?? active.execution.candidateSnapshotId
        await this.updateExecution(active, {
          state: 'interrupted',
          interruptReason: 'writeUnknown',
          failure: safeFailureWithDiagnosticRef(
            new SceneGenerationWriteOutcomeUnknown(writeRecovery.reason, writeRecovery.cause),
            retainedCandidate === undefined
              ? undefined
              : {
                  candidateSnapshotId: retainedCandidate,
                  previewAuthorization: 'readOnly'
                }
          ),
          live: undefined,
          step: undefined,
          interaction: undefined,
          requiresCleanup: false,
          ...(retainedCandidate === undefined
            ? {}
            : { candidateSnapshotId: retainedCandidate })
        })
        return
      }
      const carryReadingStage =
        writeRecovery.outcome === 'proven' && writeRecovery.carryReadingStage
      if (writeRecovery.outcome === 'proven') {
        // 先把已证明的写入绑定到执行记录，再从该修订恢复工作区；
        // 旧检查点不再对应本次候选时，按新候选重新判定，不重放已消费的回复或暂停边界。
        const candidateChanged =
          active.execution.candidateSnapshotId !== writeRecovery.candidateSnapshotId
        if (candidateChanged || writeRecovery.checkpointSuperseded)
          await this.updateExecution(active, {
            ...(candidateChanged
              ? { candidateSnapshotId: writeRecovery.candidateSnapshotId }
              : {}),
            ...(writeRecovery.checkpointSuperseded
              ? {
                  checkpointId: undefined,
                  forkRequest: undefined,
                  step: undefined
                }
              : {})
          })
      }
      // 进入 running 时清空上一轮人工交互；写后读取边界必须保留可证明的 reading 阶段，
      // 否则工作流会把同一检查点误当成缺少暂停依据。
      await this.updateExecution(active, {
        state: 'running',
        ...(carryReadingStage
          ? { step: 'reading' as const, interruptReason: 'readInterrupted' as const }
          : { step: 'preparing' as const, interruptReason: undefined }),
        interaction: undefined
      })
      let workspace: SceneGenerationWorkspace
      let addedRevision: string | undefined
      if (repairInput && !active.execution.candidateSnapshotId) {
        // 已证明的修复输入直接复用；未证明时才按来源物化，仍由工作区网关保证不清理无证据现场。
        if (preparedRepairInput === undefined)
          preparedRepairInput = await this.deps.workspace.materializeRepairInput(
            active.execution,
            repairInput
          )
        workspace = preparedRepairInput
        addedRevision = preparedRepairInput.candidateSnapshotId
      } else if (restore || active.execution.candidateSnapshotId) {
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
        userAbortSignal: userSignal,
        activeTimeoutSignal: timeoutController.signal,
        publishProgress: async (progress) => {
          if (!this.host.owns(active)) return structuredClone(active.execution)
          if (isTerminal(active.execution)) return structuredClone(active.execution)
          const settled = isTerminal(active.execution)
          const terminalProgress = progress.step === undefined
          const { artifactValidation, ...rest } = progress
          const publishedCandidates = publishCandidateRecord(
            active.execution.publishedCandidates,
            progress
          )
          await this.updateExecution(active, {
            ...rest,
            ...(artifactValidation ? { artifactValidation } : {}),
            ...(publishedCandidates === undefined ? {} : { publishedCandidates }),
            // 新等待与交互、检查点和候选是同一条持久转换：启动本轮的回复已被消费，
            // 不能留给下一次等待当作授权重放；暂停意图到达等待边界即失效。
            ...(rest.state === 'waiting'
              ? {
                  pendingReply: undefined,
                  ...(active.execution.pauseRequested === true ? { pauseRequested: false } : {})
                }
              : {}),
            budget: retainedBudget(active.execution.budget, {
              ...progress.budget,
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
          if (!this.host.owns(active)) return structuredClone(active.execution)
          await this.updateExecution(active, {
            candidateSnapshotId: revision.candidateSnapshotId
          })
          return structuredClone(active.execution)
        },
        recordFailure: async (failure) => {
          if (!this.host.owns(active)) return structuredClone(active.execution)
          await this.updateExecution(active, { failure })
          return structuredClone(active.execution)
        }
      })
      // 旧运行的结果不能覆盖新代次，也不能触发提交。
      if (!this.host.owns(active)) return
      signal.throwIfAborted()
      const waiting = outcome.state === 'waiting'
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
        // 暂停时保留尚未执行完的修改/整组回答，显式继续后按原回复边界续做；
        // 接受回复由 reviewAccepted 承接，避免恢复时被当成新的接受请求。
        pendingReply:
          outcome.state === 'interrupted' &&
          outcome.interruptReason === 'paused' &&
          (active.execution.pendingReply?.reply.kind === 'revise' ||
            active.execution.pendingReply?.reply.kind === 'answers')
            ? active.execution.pendingReply
            : undefined,
        // 需作者决定的等待必须与状态、完整交互、检查点和候选一次写入；
        // 工作流已发布的等待进度在这里只补同一份权威事实。暂停请求同时消费。
        ...(waiting
          ? {
              state: 'waiting' as const,
              step: undefined,
              interaction: outcome.interaction,
              ...(active.execution.pauseRequested === true ? { pauseRequested: false } : {})
            }
          : { interaction: undefined }),
        forkRequest: undefined,
        // 写后读取成功或进入新的审阅/修正后，旧中断事实必须被消费；
        // 后续真正的暂停/待核对分支会写回权威原因。
        interruptReason: undefined,
        failure: undefined
      })
      const unsafeInterrupt =
        outcome.state === 'interrupted' &&
        (outcome.interruptReason === 'commitUnknown' ||
          outcome.interruptReason === 'candidateConflict' ||
          outcome.interruptReason === 'writeUnknown')
      if (unsafeInterrupt) {
        await this.updateExecution(active, {
          state: 'interrupted',
          interruptReason: outcome.interruptReason,
          step: undefined
        })
      } else if (outcome.state === 'interrupted') {
        // 工作流只在持久化安全边界后返回暂停；本次暂停请求已由中断消费。
        await this.updateExecution(active, {
          state: 'interrupted',
          interruptReason: 'paused',
          pauseRequested: false
        })
      } else if (outcome.state !== 'waiting') {
        // 等待状态、交互、检查点与候选已在上一次权威更新中一起写入，不再分两次发布。
        await this.commit.commitGeneration(this, active, signal)
      }
    } catch (error) {
      // 被新代次接管的旧运行不能改写当前记录或回退当前工作区。
      if (!this.host.owns(active)) return
      if (isTerminal(active.execution)) throw error
      await this.recovery.recoverFailure(
        this,
        active,
        error,
        // 取消受理后旧运行可能由持久事实拒绝，而不是内存信号中止；两者都按取消结算。
        active.controller.signal.aborted ||
          active.execution.cancellationRequested === true ||
          active.execution.state === 'cancelling',
        true
      )
    } finally {
      cancelActiveTimer?.()
      this.host.release(active)
    }
  }

  /**
   * 提交与暂停的资格在同一个串行段内裁决：已受理暂停保留持久边界、候选与校验结论，
   * 不写正式作品；没有暂停时原子进入 committing，之后到达的暂停由暂停入口拒绝。
   * @returns 是否允许执行不可撤销提交。
   * @throws {AppException} 状态写入失败或调用方已失去该运行。
   */
  enterCommitGate(
    active: ActiveSceneGeneration,
    preview: SceneGenerationExecution['preview'],
    signal: AbortSignal
  ): Promise<boolean> {
    return this.queue.serialize(threadKey(active.execution), async () => {
      if (!this.host.owns(active)) return false
      if (isTerminal(active.execution)) return false
      signal.throwIfAborted()
      // 已受理取消优先于不可撤销提交：按持久事实拒绝，不依赖旧调用方是否看过信号。
      if (
        active.execution.state === 'cancelling' ||
        active.execution.cancellationRequested === true
      )
        throw new AppException({ code: ErrorCodes.operationConflict, msg: '场景生成已取消' })
      if (active.execution.pauseRequested === true) {
        const recorded = await this.writeExecution({
          ...active.execution,
          preview,
          state: 'interrupted',
          interruptReason: 'paused',
          step: undefined,
          interaction: undefined,
          pendingReply: undefined,
          pauseRequested: false,
          live: undefined,
          sequence: active.execution.sequence + 1
        })
        active.execution = recorded.execution
        return false
      }
      const recorded = await this.writeExecution({
        ...active.execution,
        preview,
        state: 'committing',
        step: 'committing',
        sequence: active.execution.sequence + 1
      })
      active.execution = recorded.execution
      return true
    })
  }

  /**
   * 正式作品提交后清除可提交结果留下的暂停边界。
   * 清理失败必须上抛给提交收尾登记为待处理，不能静默吞掉。
   */
  async clearPauseBoundary(execution: SceneGenerationExecution): Promise<void> {
    const control = this.deps.workflowControl
    if (control) await control.clearPauseBoundary(execution)
  }

  updateExecution(
    active: ActiveSceneGeneration,
    patch: Partial<SceneGenerationExecution>
  ): Promise<void> {
    return this.queue.serialize(threadKey(active.execution), async () => {
      // 旧运行已释放或被新代次替换时，迟到的写入必须丢弃。
      if (!this.host.owns(active)) return
      if (isTerminal(active.execution) && patch.state && patch.state !== active.execution.state)
        return
      // 取消已受理是持久事实：旧运行不能把状态改回等待/运行，也不能重新建立
      // 交互或待执行回复。只允许结算清理事实；冲突时抛出，由本次运行统一按取消收尾。
      if (revokesAcceptedCancellation(active.execution, patch))
        throw new AppException({ code: ErrorCodes.operationConflict, msg: '场景生成已取消' })
      const previousSnapshot = active.execution.candidateSnapshotId
      const previousCheckpoint = active.execution.checkpointId
      const nextSnapshot = patch.candidateSnapshotId
      const nextCheckpoint = patch.checkpointId
      // 校验结论绑定候选修订：新修订落盘时旧报告立即失效，不能借用上一版的通过结论。
      const candidateChanged = nextSnapshot !== undefined && nextSnapshot !== previousSnapshot
      const nextPatch =
        candidateChanged && patch.artifactValidation === undefined
          ? { ...patch, artifactValidation: undefined }
          : patch
      const updated = { ...active.execution, ...nextPatch, sequence: active.execution.sequence + 1 }
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
        listener(
          toRenderProgressEvent(
            recorded,
            canContinue,
            this.deps.workflow.capabilities()
          )
        )
      }
    }
    return { execution: recorded, canContinue }
  }
}

/**
 * 已受理取消只能向终态或待核对结算，不能被旧运行的迟到进度改回活动/等待，
 * 也不能重新写入交互或待执行回复。取消清理本身仍可写 cancelled/interrupted。
 */
function revokesAcceptedCancellation(
  execution: SceneGenerationExecution,
  patch: Partial<SceneGenerationExecution>
): boolean {
  if (execution.state !== 'cancelling' && execution.cancellationRequested !== true) return false
  const resumes =
    patch.state === 'pending' ||
    patch.state === 'running' ||
    patch.state === 'waiting' ||
    patch.state === 'committing' ||
    (patch.state === 'interrupted' && patch.interruptReason === 'paused')
  return resumes || patch.interaction !== undefined || patch.pendingReply !== undefined
}

/**
 * 只有同时带检查点、候选修订和“无问题”校验结论的进度才登记为已发布候选。
 * 旧修订保留在列表中，供按原检查点只读预览；不根据任意 Git 对象补造。
 */
function publishCandidateRecord(
  previous: readonly SceneGenerationPublishedCandidate[] | undefined,
  progress: SceneGenerationWorkflowProgress
): readonly SceneGenerationPublishedCandidate[] | undefined {
  const report = progress.artifactValidation
  if (
    !report ||
    report.issues.length > 0 ||
    progress.candidateSnapshotId === undefined ||
    progress.checkpointId === undefined
  )
    return undefined
  const entry: SceneGenerationPublishedCandidate = {
    candidateSnapshotId: progress.candidateSnapshotId,
    checkpointId: progress.checkpointId,
    artifactValidation: report
  }
  const records = previous ?? []
  const index = records.findIndex(
    (record) => record.candidateSnapshotId === entry.candidateSnapshotId
  )
  if (index < 0) return [...records, entry]
  const current = records[index]
  if (
    current.checkpointId === entry.checkpointId &&
    JSON.stringify(current.artifactValidation) === JSON.stringify(entry.artifactValidation)
  )
    return undefined
  return records.map((record, position) => (position === index ? entry : record))
}

async function renderCanContinue(
  deps: SceneGenerationDependencies,
  execution: SceneGenerationExecution
): Promise<boolean | undefined> {
  if (
    execution.state !== 'interrupted' ||
    execution.interruptReason === 'commitUnknown' ||
    execution.interruptReason === 'candidateConflict' ||
    execution.interruptReason === 'writeUnknown' ||
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
    execution.interruptReason === 'candidateConflict' ||
    execution.interruptReason === 'writeUnknown'
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
