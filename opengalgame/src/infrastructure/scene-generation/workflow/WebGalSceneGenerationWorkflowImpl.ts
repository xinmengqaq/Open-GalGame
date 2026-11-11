import { Command } from '@langchain/langgraph'
import type { SceneGenerationWorkflow } from '@application/scene-generation/ports/SceneGenerationWorkflow'
import type { SceneGenerationWorkflowControl } from '@application/scene-generation/ports/SceneGenerationWorkflowControl'
import type {
  SceneGenerationRuntime,
  SceneGenerationExecution,
  SceneGenerationCandidate,
  SceneGenerationWorkflowProgress,
  SceneGenerationWorkflowOutcome
} from '@application/scene-generation/models/SceneGenerationExecution'
import type {
  ForkSceneGenerationDTO,
  ReplySceneGenerationInteractionDTO
} from '@application/scene-generation/dto/SceneGenerationDTO'
import type { Agent } from '@infrastructure/ai/agents/Agent'
import { ExecutionBudget } from '@infrastructure/ai/execution/ExecutionBudget'
import type { AiProjectFileSystemImpl } from '@infrastructure/ai/filesystem/AiProjectFileSystemImpl'
import { runWorkflow } from '@infrastructure/workflow/execution/runWorkflow'
import { langGraphThreadKey } from '@infrastructure/workflow/WorkflowIdentity'
import {
  assessContinuation,
  forkWorkflowBranch
} from '@infrastructure/workflow/history/workflowHistory'
import {
  readDurableEffects,
  settleStartedDurableEffects
} from '@infrastructure/workflow/execution/durableEffect'
import type { WebGalSceneAgentInput, WebGalSceneAgentOutput } from '../agents/WebGalSceneAgentTypes'
import {
  createWebGalGenerationGraph,
  generationInteraction,
  type WebGalGenerationGraphDependencies
} from './createWebGalGenerationGraph'
import {
  generationInputDigest,
  webGalGenerationCompatibility,
  readWebGalGenerationCheckpoint
} from '../history/WebGalGenerationCheckpoint'
import type { WebGalGenerationStateValue } from './WebGalGenerationState'
import {
  nextActionsOf,
  SceneGenerationRunFailed,
  type FailureClass
} from '@application/scene-generation/models/SceneGenerationRunOutcome'
import { classifyRunError, failureCodeOf, type RunErrorClassification } from './runFailureRouting'
import {
  safeFailure,
  type SceneGenerationFailureFact
} from '@application/scene-generation/services/impl/SceneGenerationFailureFacts'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { normalizeAgentError } from '@infrastructure/ai/middleware/retryPolicy'
import { WorkflowError } from '@infrastructure/workflow/WorkflowError'
import { SceneGenerationProgressPublisher } from './SceneGenerationProgressPublisher'

/** 工作流图的技术步数上限。不由修正次数或活跃秒数换算。 */
const workflowGraphStepCeiling = 256

export class WebGalSceneGenerationWorkflowImpl
  implements SceneGenerationWorkflow, SceneGenerationWorkflowControl
{
  private readonly pauseRequested: Record<string, true> = {}
  /**
   * 使用共用执行器、文件检查点和持久副作用，不实现另一套重试或循环。
   * 智能体按运行创建并读取当次连接设置；未配置时只让本次生成失败。
   */
  constructor(
    private readonly deps: WebGalGenerationGraphDependencies,
    private readonly files: AiProjectFileSystemImpl,
    private readonly createAgent: () => Promise<
      Agent<WebGalSceneAgentInput, WebGalSceneAgentOutput>
    >
  ) {}

  async requestPauseAtSafeCheckpoint(execution: SceneGenerationExecution): Promise<void> {
    if (execution.pauseRequested === true) this.pauseRequested[execution.operationId] = true
  }

  /** 新操作读取当前输入，分支安全摘要继续沿用。 */
  executeGeneration(runtime: SceneGenerationRuntime): Promise<SceneGenerationWorkflowOutcome> {
    return this.run(runtime, 'generate')
  }

  /** 恢复先核对本操作持久副作用；没有应用检查点时也不重验未确认写入。 */
  async resumeGeneration(runtime: SceneGenerationRuntime): Promise<SceneGenerationWorkflowOutcome> {
    await this.requireConfirmedEffects(runtime)
    if (runtime.execution.checkpointId) await this.requireCheckpoint(runtime)
    return this.run(runtime, 'resume')
  }

  /** 回复已经由应用可靠接受，等待节点只消费这一份身份。 */
  async continueInteraction(
    runtime: SceneGenerationRuntime
  ): Promise<SceneGenerationWorkflowOutcome> {
    await this.requireCheckpoint(runtime)
    return this.run(runtime, 'reply')
  }

  /** 复制真实历史检查点后以新身份和当前输入启动，不重放来源副作用。 */
  async forkGeneration(
    runtime: SceneGenerationRuntime,
    request: ForkSceneGenerationDTO
  ): Promise<SceneGenerationWorkflowOutcome> {
    const source = await readWebGalGenerationCheckpoint(this.deps, this.files, request)
    if (!source.view.canContinue)
      throw new AppException({ code: ErrorCodes.operationConflict, msg: source.view.reason! })
    await forkWorkflowBranch({
      graph: createWebGalGenerationGraph(this.deps),
      saver: this.deps.saver,
      source: source.execution,
      branchId: runtime.execution.branchId,
      operationId: runtime.execution.operationId,
      checkpointId: request.checkpointId,
      effects: await readDurableEffects(this.deps.stateRoot, source.execution)
    })
    return this.run(
      runtime,
      request.inputChanges || request.decisionChanges?.length ? 'forkRepair' : 'fork'
    )
  }

  /** 写入结果未确认时停止恢复，保留已发布候选，不进入重验或提交。 */
  private async requireConfirmedEffects(runtime: SceneGenerationRuntime): Promise<void> {
    const assessed = assessContinuation(
      await readDurableEffects(this.deps.stateRoot, runtime.execution)
    )
    if (!assessed.continuable)
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: assessed.reason ?? '副作用结果尚未确认，不能继续'
      })
  }

  /** 原身份、输入摘要、候选和操作必须与当前应用记录一致。 */
  private async requireCheckpoint(runtime: SceneGenerationRuntime): Promise<void> {
    const checkpoint = await readWebGalGenerationCheckpoint(this.deps, this.files, {
      ...runtime.execution,
      checkpointId: runtime.execution.checkpointId!
    })
    if (
      !checkpoint.view.canContinue ||
      checkpoint.execution.operationId !== runtime.execution.operationId ||
      checkpoint.execution.threadId !== runtime.execution.threadId ||
      checkpoint.execution.branchId !== runtime.execution.branchId ||
      checkpoint.candidateSnapshotId !== runtime.execution.candidateSnapshotId ||
      generationInputDigest(checkpoint.execution) !== generationInputDigest(runtime.execution)
    )
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: checkpoint.view.reason ?? '恢复输入或候选版本已变化'
      })
  }

  /** 运行上下文通过闭包绑定，同步落检查点后才发布对应安全进度。 */
  private async run(
    runtime: SceneGenerationRuntime,
    entry: 'generate' | 'resume' | 'reply' | 'fork' | 'forkRepair'
  ): Promise<SceneGenerationWorkflowOutcome> {
    const execution = runtime.execution
    const budget = new ExecutionBudget(
      {
        modelAttempts: Number.MAX_SAFE_INTEGER,
        toolCalls: Number.MAX_SAFE_INTEGER,
        activeMs: Number.MAX_SAFE_INTEGER
      },
      {
        modelAttempts: execution.budget.modelCallsUsed,
        toolCalls: execution.budget.toolCallsUsed,
        activeMs: execution.budget.activeElapsedMs,
        tokens: execution.budget.totalTokens ?? 0,
        ...(execution.budget.inputTokens === undefined
          ? {}
          : { inputTokens: execution.budget.inputTokens }),
        ...(execution.budget.outputTokens === undefined
          ? {}
          : { outputTokens: execution.budget.outputTokens })
      }
    )
    let currentExecution = execution
    const publisher = new SceneGenerationProgressPublisher({
      publish: async (progress) => {
        currentExecution = await runtime.publishProgress(progress)
        return currentExecution
      },
      budget,
      previousBudget: () => currentExecution.budget,
      attempt: () => currentExecution.attempt,
      signal: runtime.signal
    })
    const publishProgress = async (
      progress: SceneGenerationWorkflowProgress
    ): Promise<SceneGenerationExecution> => {
      currentExecution = await runtime.publishProgress(progress)
      return currentExecution
    }
    try {
      const agent = await this.createAgent()
      const graph = createWebGalGenerationGraph({
        ...this.deps,
        agent,
        budget,
        agentProgress: (event) => publisher.observe(event),
        runtime: {
          ...runtime,
          publishProgress,
          recordCandidateRevision: async (revision) => {
            currentExecution = await runtime.recordCandidateRevision(revision)
            return currentExecution
          }
        },
        pauseRequested: () =>
          this.pauseRequested[execution.operationId] === true ||
          currentExecution.pauseRequested === true
      })
      publisher.start()
      const config = {
        configurable: { thread_id: langGraphThreadKey(execution), checkpoint_ns: '' }
      }
      const previous = await graph.getState(config)
      const previousState = previous.values as Partial<WebGalGenerationStateValue>
      if (entry === 'resume') await this.requireConfirmedEffects(runtime)
      const candidate =
        execution.mode === 'repair' && execution.repairSource && !execution.checkpointId
          ? undefined
          : execution.candidateSnapshotId
            ? await this.deps.artifacts.readCandidate(execution, execution.candidateSnapshotId)
            : undefined
      const resume = entry === 'resume' && execution.checkpointId && previous.next.length > 0
      const input =
        entry === 'reply'
          ? new Command<
              unknown,
              Partial<WebGalGenerationStateValue>,
              | '__start__'
              | 'prepare'
              | 'writeCandidate'
              | 'validateCandidate'
              | 'waitForHuman'
              | 'finalize'
              | 'repair'
              | 'retry'
              | 'settle'
            >({ resume: execution.pendingReply!.replyId })
          : resume
            ? null
            : this.initialRunState(execution, entry, previousState, candidate)
      let result: Awaited<ReturnType<typeof runWorkflow>>
      try {
        result = await runWorkflow(graph, input, {
          identity: {
            ...execution,
            ...(resume ? { checkpointId: execution.checkpointId } : { checkpointId: undefined })
          },
          budget,
          stateRoot: this.deps.stateRoot,
          recursionLimit: workflowGraphStepCeiling,
          signal: runtime.signal
        })
        const failedSnapshot = await graph.getState(config)
        const failedState = failedSnapshot.values as WebGalGenerationStateValue
        if (failedState.status === 'failed') {
          const failureClass = failedState.failureClass ?? 'internal'
          throw new SceneGenerationRunFailed({
            failureClass,
            ...(failedState.failureReason ? { reason: failedState.failureReason } : {}),
            message: failedState.failureMessage ?? '生成未完成',
            code: failureCodeOf(failureClass)
          })
        }
      } catch (error) {
        const consumed = persistedBudget(currentExecution.budget, budget)
        const terminalState = terminalPhase(runtime)
        const failureSource =
          error instanceof WorkflowError && error.cause !== undefined ? error.cause : error
        // 活跃超时会中止信号；终态阶段已区分取消与失败，失败时忽略信号再分类。
        const classified =
          terminalState === 'failed' ? classifyRunError(failureSource, undefined) : undefined
        const failure =
          terminalState === 'failed'
            ? terminalFailureOf(failureSource, classified, currentExecution)
            : undefined
        let recordError: unknown
        try {
          const snapshot = await graph.getState(config)
          const state = snapshot.values as Partial<WebGalGenerationStateValue>
          const failed = {
            ...(state.execution ?? currentExecution),
            ...currentExecution,
            state: terminalState,
            step: undefined,
            budget: consumed,
            interaction: undefined,
            pendingReply: undefined,
            ...(failure ? { failure: failure.fact } : {})
          }
          const recorded = await graph.updateState(config, {
            execution: failed,
            status: 'failed' as const,
            ...(classified ? { failureClass: classified.failureClass } : {}),
            ...(classified?.reason ? { failureReason: classified.reason } : {}),
            ...(failure ? { failureMessage: failure.fact.message } : {})
          })
          if (failure) currentExecution = await runtime.recordFailure(failure.fact)
          await settleStartedDurableEffects(this.deps.stateRoot, execution)
          await publishProgress({
            // 结算事件不带业务 step：终态以 state 为权威，预算取工作流结算值。
            step: undefined,
            attempt: failed.attempt,
            budget: consumed,
            live: undefined,
            checkpointId: String(recorded.configurable!.checkpoint_id),
            ...(failed.candidateSnapshotId
              ? { candidateSnapshotId: failed.candidateSnapshotId }
              : {})
          })
        } catch (recordingError) {
          recordError = recordingError
        }
        if (recordError !== undefined)
          throw new AppException({
            code: ErrorCodes.internalError,
            msg: '工作流失败且检查点记录未完整保存',
            cause: new AggregateError([error, recordError])
          })
        if (!failure) throw error
        throw failure.publicError
      } finally {
        publisher.dispose()
      }
      const snapshot = await graph.getState(config)
      const state = snapshot.values as WebGalGenerationStateValue
      const checkpointId = String(snapshot.config.configurable!.checkpoint_id)
      const consumed = {
        ...persistedBudget(state.execution.budget, budget),
        correctionsUsed: state.execution.budget.correctionsUsed
      }
      await publishProgress({
        step: 'validating',
        attempt: state.execution.attempt,
        checkpointId,
        candidateSnapshotId: state.execution.candidateSnapshotId,
        artifactValidation: state.execution.artifactValidation,
        budget: consumed,
        live: undefined
      })
      delete this.pauseRequested[execution.operationId]
      if (state.status === 'paused')
        return {
          state: 'interrupted',
          interruptReason: 'paused',
          checkpointId,
          ...(state.execution.candidateSnapshotId
            ? { candidateSnapshotId: state.execution.candidateSnapshotId }
            : {}),
          budget: consumed
        }
      if (result.status === 'interrupted')
        return {
          state: 'waiting',
          checkpointId,
          candidateSnapshotId: state.execution.candidateSnapshotId,
          budget: consumed,
          interaction: generationInteraction(state, checkpointId)
        }
      if (!state.execution.candidateSnapshotId)
        throw new AppException({ code: ErrorCodes.internalError, msg: '工作流未产生可靠候选修订' })
      return {
        state: 'ready',
        checkpointId,
        candidateSnapshotId: state.execution.candidateSnapshotId,
        budget: consumed
      }
    } finally {
      publisher.dispose()
    }
  }

  /**
   * 非 resume 入口只延续已确认上下文；本次运行事实从零开始，不继承旧检查点。
   * @param candidate - 当前操作保留的候选修订；只有它决定权威写入集合。
   */
  private initialRunState(
    execution: SceneGenerationExecution,
    entry: 'generate' | 'resume' | 'reply' | 'fork' | 'forkRepair',
    previousState: Partial<WebGalGenerationStateValue>,
    candidate: SceneGenerationCandidate | undefined
  ): Partial<WebGalGenerationStateValue> {
    const repairSource = execution.repairSource !== undefined
    const decisionChanged = (execution.forkRequest?.decisionChanges?.length ?? 0) > 0
    return {
      execution,
      mode:
        execution.mode === 'repair' ||
        entry === 'forkRepair' ||
        execution.pendingReply?.reply.kind === 'revise'
          ? ('repair' as const)
          : execution.mode === 'validate'
            ? ('validate' as const)
            : candidate
              ? ('validate' as const)
              : ('generate' as const),
      candidate,
      summary: repairSource || decisionChanged ? '' : (previousState.summary ?? ''),
      unresolvedIssues: repairSource ? [] : (previousState.unresolvedIssues ?? []),
      memoryMessages: repairSource || decisionChanged ? [] : (previousState.memoryMessages ?? []),
      confirmedReplies: confirmedRepliesForRun(
        repairSource ? [] : (previousState.confirmedReplies ?? []),
        execution
      ),
      // D2：候选存在时旧题组失效，不再作为本次决定边界。
      questions: execution.candidateSnapshotId ? [] : (previousState.questions ?? []),
      status: 'working' as const,
      needsDecision: false,
      outcome: undefined,
      retryCount: 0,
      finalizeCount: 0,
      repairRequested: false,
      blockedReason: undefined,
      failureClass: undefined,
      failureReason: undefined,
      failureMessage: undefined,
      writtenFiles: initialWrittenFiles(execution, candidate),
      correctableIssueKey: undefined,
      summaryDegraded: undefined,
      compatibility: webGalGenerationCompatibility()
    }
  }
}

/**
 * 从原始错误生成持久化事实和公开错误。公开错误只带窄原因，
 * 分类、原因名和诊断编号由原错误链在 safeFailure 中保留。
 */
function terminalFailureOf(
  source: unknown,
  classified: RunErrorClassification | undefined,
  execution: SceneGenerationExecution
): {
  fact: SceneGenerationFailureFact
  publicError: SceneGenerationRunFailed
} {
  const diagnostic = source instanceof AppException ? source : normalizeAgentError(source)
  const candidate = execution.candidateSnapshotId
    ? {
        candidateSnapshotId: execution.candidateSnapshotId,
        previewAuthorization: 'readOnly' as const
      }
    : undefined
  const base = safeFailure(diagnostic, candidate)
  const failureClass: FailureClass =
    classified?.failureClass ??
    (source instanceof SceneGenerationRunFailed ? source.failureClass : 'internal')
  const reason = classified?.reason ?? base.reason
  const code = failureCodeOf(failureClass)
  const fact: SceneGenerationFailureFact = {
    ...base,
    code,
    failureClass,
    nextActions: nextActionsOf(failureClass),
    ...(reason ? { reason } : {})
  }
  const publicError =
    source instanceof SceneGenerationRunFailed
      ? source
      : new SceneGenerationRunFailed({
          failureClass,
          ...(classified?.reason ? { reason: classified.reason } : {}),
          message: base.message,
          code,
          cause: diagnostic
        })
  return { fact, publicError }
}

/**
 * 用独立的用户取消和活跃超时区分终态。
 * 合并信号已经中止时，不能据此把超时写成取消。
 * @returns 用户取消为 cancelled，超时和其他失败为 failed。
 */
export function terminalPhase(runtime: SceneGenerationRuntime): 'cancelled' | 'failed' {
  if (runtime.activeTimeoutSignal.aborted && !runtime.userAbortSignal.aborted) return 'failed'
  if (runtime.userAbortSignal.aborted) return 'cancelled'
  return 'failed'
}
function persistedBudget(
  previous: SceneGenerationExecution['budget'],
  budget: ExecutionBudget
): SceneGenerationExecution['budget'] {
  const usage = budget.usage
  return {
    ...previous,
    modelCallsUsed: usage.modelAttempts,
    toolCallsUsed: usage.toolCalls,
    activeElapsedMs: usage.activeMs,
    ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
    totalTokens: usage.tokens,
    tokenLimit: budget.limits.tokens ?? previous.tokenLimit ?? null
  }
}

/**
 * 候选修订的可写文件只有场景入口；既有候选存在时以该入口作为权威集合。
 * 不从旧运行继承写入路径，也不把候选快照中的其他文件当成本次写入。
 */
function initialWrittenFiles(
  execution: SceneGenerationExecution,
  candidate: SceneGenerationCandidate | undefined
): readonly string[] {
  if (!candidate?.artifact.hasEntry) return []
  return [`${execution.source.sceneDirectory}/${execution.source.entryFile}`]
}

function confirmedRepliesForRun(
  previous: readonly ReplySceneGenerationInteractionDTO[],
  execution: SceneGenerationRuntime['execution']
): ReplySceneGenerationInteractionDTO[] {
  const replacements = replacementReplies(execution)
  const replaced = new Set(replacements.map((reply) => reply.interactionId))
  return [
    ...previous.filter(
      (reply) =>
        !replaced.has(reply.interactionId) &&
        !execution.replies.some(
          (current) =>
            current.replyId === reply.replyId && current.operationId === reply.operationId
        )
    ),
    ...execution.replies,
    ...replacements
  ]
}

/**
 * 同一交互只保留最后一次替换。
 * @returns 新的已确认回复；没有替换时为空。
 */
function replacementReplies(
  execution: SceneGenerationRuntime['execution']
): ReplySceneGenerationInteractionDTO[] {
  const changes = execution.forkRequest?.decisionChanges ?? []
  const byInteraction = new Map<string, ReplySceneGenerationInteractionDTO>()
  changes.forEach((change, index) => {
    byInteraction.set(change.interactionId, {
      projectId: execution.projectId,
      sceneId: execution.sceneId,
      operationId: execution.operationId,
      threadId: execution.threadId,
      branchId: execution.branchId,
      interactionId: change.interactionId,
      checkpointId: execution.forkRequest!.checkpointId,
      candidateSnapshotId: execution.candidateSnapshotId,
      replyId: `fork-decision-${index}`,
      reply: change.reply
    })
  })
  return [...byInteraction.values()]
}
