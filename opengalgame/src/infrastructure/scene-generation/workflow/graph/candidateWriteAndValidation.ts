import { createHash } from 'node:crypto'
import type { LangGraphRunnableConfig } from '@langchain/langgraph'
import type { SceneGenerationExecution } from '@application/scene-generation/models/SceneGenerationExecution'
import type { RunOutcome } from '@application/scene-generation/models/SceneGenerationRunOutcome'
import { toDomainRequest } from '@application/scene-generation/policies/SceneGenerationCandidatePolicy'
import type { SceneGenerationQuestionVO } from '@application/scene-generation/vo/SceneGenerationVO'
import { SceneGenerationDomainServiceImpl } from '@domain/scene-generation/services/impl/SceneGenerationDomainServiceImpl'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { FinalizeRequested } from '@infrastructure/ai/execution/executionErrors'
import { writtenFileFacts } from '@infrastructure/ai/execution/writtenFileLedger'
import { unwind } from '@infrastructure/ai/middleware/retryPolicy'
import { enrichMissingAssetDiagnostics } from '@infrastructure/scene-generation/artifacts/missingAssetDiagnostics'
import { langGraphThreadKey } from '@infrastructure/workflow/WorkflowIdentity'
import {
  writeDurableEffect,
  readDurableEffects,
  decideDurableEffectRecovery,
  abandonDurableEffect
} from '@infrastructure/workflow/execution/durableEffect'
import type { WebGalSceneAgentOutput } from '../../agents/WebGalSceneAgentTypes'
import type { WebGalGenerationStateValue } from '../WebGalGenerationState'
import { classifyRunError, RunFailure } from '../runFailureRouting'
import type { WebGalGenerationGraphDependencies } from './graphDependencies'
import { budgetSnapshot, finishCandidateEffect } from './settlement'
import { assignedQuestions } from './stateFacts'

export function createWriteCandidateNode(deps: WebGalGenerationGraphDependencies) {
  return async (state: WebGalGenerationStateValue, config: LangGraphRunnableConfig) => {
    if (!deps.runtime || !deps.agent || !deps.budget)
      throw new AppException({ code: ErrorCodes.internalError, msg: '只读历史图不能执行生成' })
    const runtime = deps.runtime
    const agent = deps.agent
    const budget = deps.budget
    const execution = {
      ...state.execution,
      source: runtime.execution.source,
      workspace: runtime.execution.workspace
    }
    const retryCount = state.retryCount ?? 0
    const stepSuffix = retryCount > 0 ? `-r${retryCount}` : ''
    const stepId = `${state.mode}-${execution.budget.correctionsUsed}-${execution.pendingReply?.replyId ?? 'initial'}${stepSuffix}`
    const inputDigest = createHash('sha256')
      .update(
        JSON.stringify({
          inputs: execution.inputSnapshot,
          replies: execution.replies,
          candidate: execution.candidateSnapshotId,
          mode: state.mode
        })
      )
      .digest('hex')
    const previous = (await readDurableEffects(deps.stateRoot, execution)).find(
      (effect) => effect.stepId === stepId
    )
    if (previous) {
      const recovery = decideDurableEffectRecovery(previous, () => ({ outcome: 'unknown' }))
      if (
        recovery.action === 'stop' ||
        (recovery.action === 'skip' && previous.inputDigest !== inputDigest)
      )
        throw new AppException({
          code: ErrorCodes.operationConflict,
          msg: '候选副作用结果不明或输入不兼容，已停止恢复'
        })
      if (recovery.action === 'skip')
        return {
          execution: {
            ...execution,
            candidateSnapshotId: recovery.candidateRevision,
            budget: budgetSnapshot(execution, budget)
          },
          // 完成结果里的题组才是崩溃前已经分配的事实；旧记录没有该字段时不补造。
          ...(previous.questions !== undefined ? { questions: previous.questions } : {}),
          ...(recovery.candidateRevision
            ? {
                outcome: {
                  kind: 'candidate' as const,
                  candidateSnapshotId: recovery.candidateRevision
                }
              }
            : {})
        }
    }
    // 没有可恢复的完成记录时仍要求工作区存在才写 started。
    if (!execution.workspace)
      throw new RunFailure({
        failureClass: 'inputInvalid',
        message: '输入快照缺少可生成的工作区或来源'
      })
    await writeDurableEffect(deps.stateRoot, execution, {
      operationId: execution.operationId,
      stepId,
      inputDigest,
      status: 'started',
      kind: 'fileWrite'
    })
    let publishing = false
    const publishGenerating = (): void => {
      if (publishing) return
      publishing = true
      void runtime
        .publishProgress({
          step: 'generating',
          attempt: execution.attempt,
          budget: budgetSnapshot(execution, budget)
        })
        .then(
          () => {
            publishing = false
          },
          () => {
            publishing = false
          }
        )
    }
    publishGenerating()
    const heartbeat = setInterval(publishGenerating, 1500)
    const executionMode =
      state.mode === 'repair' ? 'repair' : state.mode === 'finalize' ? 'finalize' : 'generate'
    let output: WebGalSceneAgentOutput | undefined
    let agentError: unknown
    try {
      output = await agent.invoke(
        {
          mode: executionMode,
          execution,
          candidate: state.candidate,
          summary: state.summary,
          writtenFiles: state.writtenFiles ?? [],
          memoryMessages: state.memoryMessages,
          confirmedReplies: state.confirmedReplies
        },
        {
          identity: { executionId: execution.operationId },
          scope: { threadId: langGraphThreadKey(execution) },
          signal: config.signal,
          context: {
            budget,
            executionMode,
            writtenFiles: state.writtenFiles ?? [],
            ...(deps.agentProgress ? { progress: deps.agentProgress } : {}),
            workspace: {
              root: execution.workspace!.rootDirectory,
              writable: true,
              writablePaths: [`${execution.source.sceneDirectory}/${execution.source.entryFile}`]
            }
          }
        }
      )
      config.signal?.throwIfAborted()
    } catch (error) {
      agentError = error
    } finally {
      clearInterval(heartbeat)
    }
    const entryPath = `${execution.source.sceneDirectory}/${execution.source.entryFile}`
    const written = writtenFileFacts(budget).filter((fact) => fact.path.length > 0)
    const writtenFiles = written.map((fact) => fact.path)
    const entryWritten = written.some((fact) => fact.path === entryPath)
    const saveRevision = async (): Promise<{ candidateSnapshotId: string }> => {
      let revision: { candidateSnapshotId: string }
      try {
        revision = await deps.artifacts.saveCandidateRevision(execution)
      } catch (saveError) {
        throw new AppException({
          code: ErrorCodes.internalError,
          msg: '候选修订保存失败',
          cause: agentError ? new AggregateError([agentError, saveError]) : saveError
        })
      }
      try {
        await runtime.recordCandidateRevision({
          candidateSnapshotId: revision.candidateSnapshotId
        })
      } catch (recordError) {
        throw new AppException({
          code: ErrorCodes.internalError,
          msg: '候选修订记录保存失败',
          cause: recordError
        })
      }
      return revision
    }
    const withRevision = (
      revision: { candidateSnapshotId: string },
      step: 'reading' | undefined
    ): SceneGenerationExecution => ({
      ...execution,
      ...revision,
      attempt: execution.attempt + 1,
      budget: budgetSnapshot(execution, budget),
      step,
      pauseRequested: deps.pauseRequested?.() === true || execution.pauseRequested
    })
    const finalized = (cause: FinalizeRequested['causeKind']): RunOutcome => ({
      kind: 'finalize',
      cause
    })
    if (!agentError && output) {
      const action = output.action ?? 'submit_scene_result'
      // 已回答或已丢弃本轮提问后不能再开新题组；候选一旦存在，也只能修正不能重新提问。
      const answeredAlready = execution.replies.some(
        (reply) => reply.reply.kind === 'answers' || reply.reply.kind === 'discard'
      )
      const hasCandidate = Boolean(
        execution.candidateSnapshotId ||
        execution.repairSource ||
        (state.writtenFiles ?? []).length > 0
      )
      if (action === 'request_clarification') {
        if (entryWritten) {
          // 同轮已经写出候选时按候选继续，题组不进入本次结果；候选后的冲突事实必须保留。
          const revision = await saveRevision()
          await finishCandidateEffect(deps.stateRoot, execution, stepId, inputDigest, revision, [])
          const updated = withRevision(revision, 'reading')
          return {
            status: 'working' as const,
            // 本轮已经给出完整结构化结果并写出候选，旧的降级事实不再成立。
            summaryDegraded: false,
            summary: [output.summary, ...output.tradeoffs].join('\n'),
            unresolvedIssues: output.unresolvedIssues,
            memoryMessages: output.memoryMessages,
            questions: [] as readonly SceneGenerationQuestionVO[],
            outcome: {
              kind: 'candidate' as const,
              candidateSnapshotId: revision.candidateSnapshotId
            },
            writtenFiles,
            candidate: undefined,
            execution: updated,
            failureClass: undefined,
            failureReason: undefined,
            failureMessage: undefined
          }
        }
        if (hasCandidate && !answeredAlready) {
          // 已有候选时请求澄清转为修正等待：题目只作为阻塞说明，不再新开题组。
          await abandonDurableEffect(deps.stateRoot, execution, stepId, inputDigest)
          const reason =
            assignedQuestions(output.questions)
              .map((question) => question.prompt)
              .join('\n') || '已有候选，需要先确认修改方向'
          return {
            status: 'waiting' as const,
            needsDecision: true,
            questions: [] as readonly SceneGenerationQuestionVO[],
            blockedReason: reason,
            outcome: { kind: 'blocked' as const, reason, processable: true as const },
            writtenFiles: state.writtenFiles ?? []
          }
        }
        if (answeredAlready) {
          await abandonDurableEffect(deps.stateRoot, execution, stepId, inputDigest)
          throw new RunFailure({
            failureClass: 'outputContract',
            reason: 'structuredOutput',
            message: '本操作只能写前提问一轮，回答后必须写候选或报告阻塞'
          })
        }
        await abandonDurableEffect(deps.stateRoot, execution, stepId, inputDigest)
        const questions = assignedQuestions(output.questions)
        return {
          status: 'waiting' as const,
          questions,
          outcome: { kind: 'questions' as const, questions },
          writtenFiles: state.writtenFiles ?? []
        }
      }
      if (action === 'report_blocked') {
        const reason = output.blockedReason ?? '模型报告无法继续'
        if (entryWritten) {
          const revision = await saveRevision()
          await finishCandidateEffect(deps.stateRoot, execution, stepId, inputDigest, revision, [])
          const updated = withRevision(revision, undefined)
          return {
            status: 'waiting' as const,
            needsDecision: true,
            questions: [],
            blockedReason: reason,
            outcome: {
              kind: 'blocked' as const,
              reason,
              processable: true as const,
              candidateSnapshotId: revision.candidateSnapshotId
            },
            writtenFiles,
            candidate: undefined,
            execution: updated
          }
        }
        await abandonDurableEffect(deps.stateRoot, execution, stepId, inputDigest)
        return {
          status: 'waiting' as const,
          needsDecision: true,
          questions: [],
          blockedReason: reason,
          outcome: {
            kind: 'blocked' as const,
            reason,
            processable: true as const,
            ...(execution.candidateSnapshotId
              ? { candidateSnapshotId: execution.candidateSnapshotId }
              : {})
          },
          writtenFiles: state.writtenFiles ?? []
        }
      }
      if (!entryWritten)
        throw new RunFailure({
          failureClass: 'outputContract',
          reason: 'missingCandidateWrite',
          message: '智能体未通过文件工具实际写入候选脚本'
        })
      const revision = await saveRevision()
      // 写出候选即按候选继续；题组只在写前澄清路径产生。
      const questions: readonly SceneGenerationQuestionVO[] = []
      await finishCandidateEffect(
        deps.stateRoot,
        execution,
        stepId,
        inputDigest,
        revision,
        questions
      )
      const paused = deps.pauseRequested?.() === true
      const updated = {
        ...execution,
        ...revision,
        attempt: execution.attempt + 1,
        budget: budgetSnapshot(execution, budget),
        step: paused ? undefined : ('reading' as const),
        pauseRequested: paused || execution.pauseRequested
      }
      await runtime.publishProgress({
        step: paused ? 'validating' : 'reading',
        attempt: updated.attempt,
        budget: updated.budget,
        candidateSnapshotId: revision.candidateSnapshotId
      })
      return {
        execution: updated,
        // 本次写入已带出完整结构化结果，后续校验按正常候选评估，不再沿用上一次降级。
        summaryDegraded: false,
        summary: [output.summary, ...output.tradeoffs].join('\n'),
        unresolvedIssues: output.unresolvedIssues,
        memoryMessages: output.memoryMessages,
        questions,
        status: paused ? ('paused' as const) : state.status,
        outcome: {
          kind: 'candidate' as const,
          candidateSnapshotId: revision.candidateSnapshotId
        },
        writtenFiles,
        // 写后检查点在读取候选前落盘：读取失败时可从 step=reading 继续。
        // 旧候选对象可能来自上一修订，必须清空，校验节点按 candidateSnapshotId 重新读取。
        candidate: undefined,
        failureClass: undefined,
        failureReason: undefined,
        failureMessage: undefined
      }
    }
    const finalizeRequest = agentError
      ? unwind(agentError).find(
          (item): item is FinalizeRequested => item instanceof FinalizeRequested
        )
      : undefined
    if (finalizeRequest) {
      if (entryWritten) {
        // 写后探针请求收尾时，本轮已经实际写出候选：按正常候选继续校验，
        // 让可修正问题进入既有 repair，而不是直接进入 finalize/等待用户。
        const revision = await saveRevision()
        await finishCandidateEffect(deps.stateRoot, execution, stepId, inputDigest, revision, [])
        const paused = deps.pauseRequested?.() === true
        const updated = {
          ...execution,
          ...revision,
          attempt: execution.attempt + 1,
          budget: budgetSnapshot(execution, budget),
          step: paused ? undefined : ('reading' as const),
          pauseRequested: paused || execution.pauseRequested
        }
        await runtime.publishProgress({
          step: paused ? 'validating' : 'reading',
          attempt: updated.attempt,
          budget: updated.budget,
          candidateSnapshotId: revision.candidateSnapshotId
        })
        return {
          status: paused ? ('paused' as const) : state.status,
          outcome: {
            kind: 'candidate' as const,
            candidateSnapshotId: revision.candidateSnapshotId
          },
          candidate: undefined,
          questions: [],
          // 强制收尾的候选没有模型提交，不继承上一轮未解决问题，避免被投影为 clarification。
          unresolvedIssues: [],
          execution: updated,
          writtenFiles,
          failureClass: undefined,
          failureReason: undefined,
          failureMessage: undefined
        }
      }
      await abandonDurableEffect(deps.stateRoot, execution, stepId, inputDigest)
      return { status: 'working' as const, outcome: finalized(finalizeRequest.causeKind) }
    }
    const errorRevision =
      agentError && entryWritten
        ? await (async () => {
            const revision = await saveRevision()
            await finishCandidateEffect(
              deps.stateRoot,
              execution,
              stepId,
              inputDigest,
              revision,
              []
            )
            return revision
          })()
        : undefined
    const withErrorRevision = {
      ...execution,
      ...errorRevision,
      budget: budgetSnapshot(execution, budget)
    }
    const classified = agentError ? classifyRunError(agentError, config.signal) : undefined
    // 取消由工作流按信号结算，节点只把原始错误带出去。
    if (agentError && !classified) throw agentError
    if (classified?.failureClass === 'outputContract' && entryWritten) {
      const revision = errorRevision
      if (!revision)
        throw new AppException({
          code: ErrorCodes.internalError,
          msg: '已写入候选但没有可结算的修订'
        })
      const updated = withRevision(revision, 'reading')
      return {
        status: 'working' as const,
        summaryDegraded: true,
        candidate: undefined,
        execution: updated,
        writtenFiles,
        outcome: {
          kind: 'contractError' as const,
          failureClass: 'outputContract' as const,
          reason: classified.reason ?? 'missingStructuredResult',
          message: classified.message,
          candidateSnapshotId: revision.candidateSnapshotId,
          degraded: true
        }
      }
    }
    if (
      classified &&
      classified.retryable &&
      (classified.failureClass === 'modelTransient' ||
        classified.failureClass === 'modelAuth' ||
        classified.failureClass === 'modelRejected' ||
        classified.failureClass === 'contextOverflow')
    ) {
      if (!entryWritten) await abandonDurableEffect(deps.stateRoot, execution, stepId, inputDigest)
      return {
        status: 'working' as const,
        outcome: {
          kind: 'modelError' as const,
          failureClass: classified.failureClass,
          retryable: classified.retryable,
          message: classified.message
        },
        failureClass: classified.failureClass,
        failureReason: classified.reason,
        failureMessage: classified.message,
        ...(errorRevision ? { execution: withErrorRevision } : {})
      }
    }
    if (!entryWritten) await abandonDurableEffect(deps.stateRoot, execution, stepId, inputDigest)
    if (agentError) throw agentError
    throw new RunFailure({ failureClass: 'internal', message: '生成节点没有返回结果' })
  }
}

export function createValidateCandidateNode(deps: WebGalGenerationGraphDependencies) {
  const domain = new SceneGenerationDomainServiceImpl()
  return async (state: WebGalGenerationStateValue) => {
    // 写入后的安全检查点已经决定暂停。不能改成等待或可提交，否则新问题会掉进没有回复的中断。
    if (state.status === 'paused' || state.execution.pauseRequested === true) {
      return { status: 'paused' as const }
    }
    const candidate =
      state.candidate && state.candidate.candidateSnapshotId === state.execution.candidateSnapshotId
        ? state.candidate
        : await deps.artifacts.readCandidate(state.execution, state.execution.candidateSnapshotId!)
    const request = toDomainRequest(state.execution, {
      baselineState: 'unchanged',
      lockState: state.execution.baseline.lockState
    })
    // 领域校验拿不到素材路径；在基础设施层补出缺失素材的最近似有效引用，供修正轮定位。
    const report = enrichMissingAssetDiagnostics(
      domain.validateArtifact(candidate.artifact, request),
      state.execution.inputSnapshot.assets
    )
    const judgment = domain.evaluateResult(report, request)
    if (judgment.status === 'rejected')
      return {
        candidate: {
          ...candidate,
          preview: { ...candidate.preview, validationReport: judgment.report }
        },
        status: 'waiting' as const,
        needsDecision: true,
        questions: [],
        correctableIssueKey: '',
        execution: {
          ...state.execution,
          artifactValidation: judgment.report,
          step: undefined
        }
      }
    const contextFeedback = contextOnly(judgment.report.issues)
    // 降级事实沿用到本次校验：只有新一轮写入带出完整结构化结果时才会清除，
    // 因此 accept 不会让降级候选静默提交，审阅交互负责给出可执行的下一步。
    const summaryDegraded = state.summaryDegraded === true
    if (judgment.status === 'correctable' && !contextFeedback && !summaryDegraded)
      return {
        repairRequested: true,
        candidate: {
          ...candidate,
          preview: { ...candidate.preview, validationReport: judgment.report }
        },
        execution: {
          ...state.execution,
          artifactValidation: judgment.report
        }
      }
    const reviewed = state.execution.pendingReply?.reply.kind === 'accept'
    // 校验阶段不再产出题组；题组只在写前澄清路径产生并消费一次。
    const questions: readonly SceneGenerationQuestionVO[] = []
    const holdForCorrection =
      !summaryDegraded && (judgment.status === 'needsDecision' || contextFeedback)
    const waiting =
      summaryDegraded ||
      holdForCorrection ||
      Boolean(state.unresolvedIssues?.length) ||
      (state.execution.reviewCandidate && !reviewed)
    return {
      candidate: {
        ...candidate,
        preview: { ...candidate.preview, validationReport: judgment.report }
      },
      status: waiting ? ('waiting' as const) : ('ready' as const),
      needsDecision: holdForCorrection,
      questions,
      correctableIssueKey: '',
      execution: {
        ...state.execution,
        artifactValidation: judgment.report,
        step: waiting ? undefined : ('validating' as const)
      }
    }
  }
}

/**
 * 只有连续对白上下文问题时，先让用户用自然语言说明，不自动改写。
 * 夹杂其他可修正问题时仍走原来的自动修正。
 */
export function contextOnly(issues: readonly { code: string }[]): boolean {
  return (
    issues.length > 0 &&
    issues.every(
      (issue) => issue.code === 'missing-background' || issue.code === 'missing-character'
    )
  )
}

/**
 * 用问题码、语句位置和说明标识当前连续修正里的一组可修正问题。
 * 只含可自动修正的问题。顺序不同仍是同一组；语句位置不同就不是同一问题。
 * @returns 稳定的问题签名。没有可自动修正的问题时为空字符串。
 */
export function correctableIssueSignature(
  issues: readonly {
    code: string
    message: string
    sequence?: number
    correctable: boolean
    requiresHumanDecision: boolean
  }[]
): string {
  return issues
    .filter((issue) => issue.correctable && !issue.requiresHumanDecision)
    .map((issue) => JSON.stringify([issue.code, issue.sequence ?? null, issue.message]))
    .sort()
    .join('\n')
}
