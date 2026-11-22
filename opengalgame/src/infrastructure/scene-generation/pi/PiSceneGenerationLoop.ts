import type { AgentTool } from '@earendil-works/pi-agent-core'
import type {
  SceneGenerationCandidate,
  SceneGenerationCandidateRevisionRecord,
  SceneGenerationExecution,
  SceneGenerationRuntime,
  SceneGenerationWorkflowOutcome
} from '@application/scene-generation/models/SceneGenerationExecution'
import { SceneGenerationReadInterrupted } from '@application/scene-generation/errors/SceneGenerationReadInterrupted'
import { SceneGenerationVersionConflict } from '@application/scene-generation/errors/SceneGenerationVersionConflict'
import { SceneGenerationWriteOutcomeUnknown } from '@application/scene-generation/errors/SceneGenerationWriteOutcomeUnknown'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { throwIfStopped } from '@infrastructure/ai/execution/executionErrors'
import { beginWrittenFileLedger } from '@infrastructure/ai/execution/writtenFileLedger'
import type { PiAgentExecutor, PiAgentRunResult } from '@infrastructure/ai/pi/PiAgentExecutor'
import type { ExecutionBudget } from '@infrastructure/ai/execution/ExecutionBudget'
import type { LoadedSkill } from '@infrastructure/ai/skills/FileSkillLoader'
import type { AgentExecutionProfile } from '@infrastructure/ai/config/agentExecutionConfig'
import {
  candidateInputDigest,
  candidateReplyStepTag,
  saveCandidateRevision
} from '@infrastructure/scene-generation/workflow/graph/candidateRevision'
import { SceneGenerationContextAssemblerImpl } from '@infrastructure/scene-generation/agents/context/SceneGenerationContextAssemblerImpl'
import { runStateBlock } from '@infrastructure/scene-generation/agents/context/SceneGenerationRunState'
import type { WebGalSceneAgentInput } from '@infrastructure/scene-generation/agents/WebGalSceneAgentTypes'
import { SceneGenerationProgressPublisher } from '@infrastructure/scene-generation/workflow/SceneGenerationProgressPublisher'
import {
  failStartedDurableEffect,
  writeDurableEffect
} from '@infrastructure/workflow/execution/durableEffect'
import { finishCandidateEffect } from '@infrastructure/workflow/execution/candidateSettlement'
import { piReviewCheckpointId } from '@infrastructure/scene-generation/workflow/piReviewCheckpoint'
import { clearPauseBoundary } from './PiPauseBoundary'
import { pauseAtSafeCheckpoint } from './PiSceneGenerationPause'
import {
  SceneCandidateToolbox,
  createSceneReadAuthority,
  readSceneDraft,
  type SceneDraftFacts,
  type SceneWriteFact
} from './SceneCandidateToolbox'
import {
  assertContextBudget,
  assertRequestWithinWindow,
  contextOnly,
  composeSystemPrompt,
  createBudget,
  executionProfile,
  issueSignature,
  modelFailure,
  settledBudget,
  validationReportOf
} from './PiSceneGenerationSupport'
import { replayReplyEffects } from './PiSceneGenerationEffects'
import type { PiSceneCandidateDecisions } from './PiSceneCandidateDecisions'
import type { PiSceneOutcomePublisher } from './PiSceneOutcomePublisher'
import {
  SceneWriteAuthority,
  type CandidateWriteReplay,
  type PassOutcome,
  type PiSceneExecutionRegistry,
  type PiSceneGenerationWorkflowDependencies,
  type ReadyBoundaryFacts,
  type RunPlan,
  type RunState
} from './PiSceneGenerationTypes'

/**
 * 一次生成/修复运行的循环与写入结算。所有候选必须由宿主读回、保存不可变修订并通过领域校验；
 * 这里不提交正式作品，也不替应用改写等待状态。
 */
export class PiSceneGenerationLoop {
  constructor(
    private readonly deps: PiSceneGenerationWorkflowDependencies,
    private readonly registry: PiSceneExecutionRegistry,
    private readonly decisions: PiSceneCandidateDecisions,
    private readonly publisher: PiSceneOutcomePublisher
  ) {}

  /** 运行一次生成、修复重跑或暂停后的续做，返回工作流终态。 */
  async run(
    runtime: SceneGenerationRuntime,
    plan: RunPlan
  ): Promise<SceneGenerationWorkflowOutcome> {
    const initial = runtime.execution
    const operationId = initial.operationId
    // 新运行开始即撤销上一代次的写资格；迟到的工具回调不能覆盖本次候选。
    const writeAuthority = this.registry.beginRun(operationId)
    const [prompt, skill] = await Promise.all([
      this.deps.prompts.load({ agentId: 'webgal-scene' }),
      this.deps.skills.load('webgal-scene')
    ]).catch((error: unknown) => {
      this.registry.endRun(operationId, writeAuthority)
      throw error
    })
    const systemPrompt = composeSystemPrompt(prompt.body, skill)
    const profile = executionProfile(this.deps.executionOverride)
    const budget = createBudget(profile, initial)
    budget.startRun(this.deps.now?.() ?? Date.now())
    // 作者新回复开启新一轮修改时，旧修正次数只留在历史预算里，不继续消耗本轮的自动修正额度。
    const state: RunState = {
      execution: plan.resetCorrections
        ? { ...initial, budget: { ...initial.budget, correctionsUsed: 0 } }
        : initial,
      ...(initial.candidateSnapshotId === undefined
        ? {}
        : { candidateSnapshotId: initial.candidateSnapshotId }),
      wroteThisRun: false,
      correctionCount: plan.resetCorrections ? 0 : initial.budget.correctionsUsed,
      reviewAccepted: plan.reviewAccepted,
      step:
        (plan.resume?.mode ?? plan.mode) === 'repair' ? 'correcting' : 'generating',
      signal: runtime.signal,
      authority: writeAuthority
    }
    const publisher = new SceneGenerationProgressPublisher({
      publish: async (progress) => {
        state.execution = await runtime.publishProgress(progress)
        return state.execution
      },
      budget,
      previousBudget: () => state.execution.budget,
      attempt: () => state.execution.attempt,
      step: () => state.step,
      signal: runtime.signal,
      ...(this.deps.now === undefined ? {} : { now: this.deps.now })
    })
    publisher.start()
    let body: PassOutcome | undefined
    let failure: unknown
    try {
      body = await this.generateLoop(
        runtime,
        state,
        this.deps.createAgent,
        systemPrompt,
        skill,
        profile,
        budget,
        publisher,
        plan.mode,
        plan.answeredWriteReplay,
        plan.resume
      )
    } catch (error) {
      failure = error
      // 终态边界必须在 finally 的发布器排空之前落下；取消可能让排空先抛错，
      // 不能因此丢失历史可见的操作边界。
      await this.publisher
        .publishFailureBoundary(runtime, state, error, state.execution.budget)
        .catch(() => undefined)
    } finally {
      this.registry.endRun(operationId, writeAuthority)
      try {
        budget.finishRun(this.deps.now?.() ?? Date.now())
      } catch (error) {
        if (failure === undefined) failure = error
      }
      publisher.dispose()
      await publisher.drain()
    }
    const settled = settledBudget(state.execution, budget, state.correctionCount)
    if (failure !== undefined) {
      await clearPauseBoundary(this.deps.stateRoot, initial).catch(() => undefined)
      // 本步写入意图已在生成循环按磁盘事实结算：只有证明未落盘才标 failed；
      // 已落盘则补完成记录；无法证明时保留 started，由恢复边界落为待核对。
      // 不能在这里把本操作所有 started 无条件改成 failed，否则会抹掉已完成写入的证据。
      // 失败事实由应用恢复边界记录；这里只把已结算预算写回，避免把运行中用量当成终值。
      // 取消/失败也保留操作边界标识：历史仍能看到这次操作；写后读取中断还要保留 reading 阶段。
      try {
        await this.publisher.publishFailureBoundary(runtime, state, failure, settled)
      } catch {
        // 原失败优先；恢复边界会再次尝试记录失败与预算。
      }
      throw failure
    }
    if (body === undefined)
      throw new AppException({ code: ErrorCodes.internalError, msg: '生成流程没有返回结果' })
    return this.publisher.outcome(body, runtime, settled)
  }

  /**
   * 复用持久写账本已证明完成的候选修订；不创建模型，也不重新保存修订。
   * started 只有在当前候选快照可归属到该步骤时才补一次 completed 结算。
   * @returns 可立即返回的等待终态；undefined 表示仍需进入下一轮修正。
   */
  private async restoreReplayedCandidate(
    state: RunState,
    execution: SceneGenerationExecution,
    replay: CandidateWriteReplay
  ): Promise<PassOutcome | undefined> {
    const candidateSnapshotId = replay.candidateSnapshotId
    if (candidateSnapshotId === undefined)
      throw new AppException({
        code: ErrorCodes.internalError,
        msg: '已完成写入缺少候选修订'
      })
    state.candidateSnapshotId = candidateSnapshotId
    state.candidate = await this.deps.artifacts.readCandidate(execution, candidateSnapshotId)
    if (replay.settlement !== undefined) {
      try {
        await finishCandidateEffect(
          this.deps.stateRoot,
          state.execution,
          replay.settlement.stepId,
          replay.settlement.inputDigest,
          { candidateSnapshotId },
          []
        )
      } catch (error) {
        throw new SceneGenerationWriteOutcomeUnknown(
          '候选完成记录未保存，已保留记录待核对',
          error
        )
      }
    }
    state.correctionCount = replay.passes - 1
    state.execution = {
      ...state.execution,
      budget: { ...state.execution.budget, correctionsUsed: state.correctionCount }
    }
    const judgment = await this.decisions.judge(state.execution, state.candidate)
    const decision = this.decisions.decideCandidate(state, state.candidate, judgment, false)
    if (decision !== undefined) return decision
    state.correctionCount = replay.passes
    state.execution = {
      ...state.execution,
      budget: { ...state.execution.budget, correctionsUsed: state.correctionCount }
    }
    return undefined
  }

  /**
   * 一次生成或修复重跑的有限循环。每轮只允许一个候选写工具；
   * 写成后由宿主读回、保存修订、解析并交给领域判断。
   */
  private async generateLoop(
    runtime: SceneGenerationRuntime,
    state: RunState,
    createAgent: () => Promise<PiAgentExecutor>,
    systemPrompt: string,
    skill: LoadedSkill,
    profile: AgentExecutionProfile,
    budget: ExecutionBudget,
    publisher: SceneGenerationProgressPublisher,
    initialMode: 'generate' | 'repair',
    answeredWriteReplay?: CandidateWriteReplay,
    resume?: RunPlan['resume']
  ): Promise<PassOutcome> {
    const execution = state.execution
    const workspaceRoot = execution.workspace!.rootDirectory
    const entryPath = `${execution.source.sceneDirectory}/${execution.source.entryFile}`
    const authority = await createSceneReadAuthority({
      workspaceRoot,
      entryPath,
      inputSnapshot: execution.inputSnapshot
    })
    // 暂停边界从这里起算：本轮开始时已有的候选不是本轮写出的修订。
    const baseCandidateSnapshotId = execution.candidateSnapshotId
    let passMode: 'generate' | 'repair' = resume?.mode ?? initialMode
    let pass = resume?.pass ?? 0
    let previousPass: { digest: string; signature: string } | undefined = resume?.previousPass
    if (state.candidateSnapshotId) {
      state.candidate = await this.deps.artifacts.readCandidate(
        execution,
        state.candidateSnapshotId
      )
    }
    const pending = execution.pendingReply
    // 本操作已回答过整组问题后，任何轮次都不能再出新题；回答本身会进入候选输入摘要。
    const answeredAlready = execution.replies.some((reply) => reply.reply.kind === 'answers')
    if (pending?.reply.kind === 'revise') {
      const replay = await replayReplyEffects(this.deps.stateRoot, execution, 'revise')
      if (replay.passes > 0) {
        // 持久账本已证明这次修改写出了候选；后续自动修正失败时按该事实说明版本与未执行步骤。
        state.authorWrite = { kind: 'revise', passes: replay.passes }
        // 已完成副作用直接复用不可变修订；不再调用模型猜这次写入写出了什么。
        const decision = await this.restoreReplayedCandidate(state, execution, replay)
        if (decision !== undefined) return decision
        // 已有写入仍可自动修正：从未完成的下一轮继续，不重放已完成的轮次。
        pass = replay.passes
        passMode = 'repair'
      } else if (pending.candidateSnapshotId !== execution.candidateSnapshotId) {
        throw new AppException({
          code: ErrorCodes.operationConflict,
          msg: '候选内容已变化，请重新审阅'
        })
      }
    } else if (
      pending?.reply.kind === 'answers' &&
      answeredWriteReplay !== undefined &&
      answeredWriteReplay.passes > 0
    ) {
      // 整组回答已写出候选：复用同一不变的修订，并只在 started 可归属时补一次完成记录。
      state.authorWrite = { kind: 'answers', passes: answeredWriteReplay.passes }
      const decision = await this.restoreReplayedCandidate(state, execution, answeredWriteReplay)
      if (decision !== undefined) return decision
      pass = answeredWriteReplay.passes
      passMode = 'repair'
    }
    for (;;) {
      throwIfStopped(runtime.signal)
      if (this.registry.pauseRequested(runtime, state)) {
        return pauseAtSafeCheckpoint({
          stateRoot: this.deps.stateRoot,
          runtime,
          state,
          workspaceRoot,
          entryPath,
          pass,
          mode: passMode,
          firstMode: initialMode,
          ...(baseCandidateSnapshotId === undefined ? {} : { baseCandidateSnapshotId }),
          ...(pending?.reply.kind === 'revise' || pending?.reply.kind === 'answers'
            ? { pendingReplyId: pending.replyId }
            : {})
        })
      }
      state.step = passMode === 'generate' ? 'generating' : 'correcting'
      // 每轮模型往返从空的写入账本开始；上一轮已写入的候选只通过权威候选事实表达，
      // 不能继续冒充本轮新写入，否则修复轮会误报“已提交”。
      beginWrittenFileLedger(budget)
      const draft = await readSceneDraft(workspaceRoot, entryPath, runtime.signal)
      const factsExecution: SceneGenerationExecution = {
        ...state.execution,
        ...(state.candidateSnapshotId === undefined
          ? {}
          : { candidateSnapshotId: state.candidateSnapshotId })
      }
      // 修改/整组回答续跑必须在副作用标识里保留本轮身份；用回复标识摘要避免把请求原文带进存储路径。
      // 接受由 reviewAccepted 承接，写入轮次保持 repair-<n>，不并入回复标记。
      const replyTag =
        execution.pendingReply?.reply.kind === 'revise' ||
        execution.pendingReply?.reply.kind === 'answers'
          ? candidateReplyStepTag(execution.pendingReply.replyId)
          : undefined
      const stepId = `${passMode}-${pass}${replyTag === undefined ? '' : `-${replyTag}`}`
      const inputDigest = candidateInputDigest(passMode, factsExecution)
      // 只在尚无候选的首次生成前允许追问；修复轮、已有候选或已回答过题组时不再提供。
      const clarificationAllowed =
        passMode === 'generate' &&
        pass === 0 &&
        state.candidateSnapshotId === undefined &&
        execution.candidateSnapshotId === undefined &&
        execution.repairSource === undefined &&
        execution.mode !== 'repair' &&
        !answeredAlready
      const toolbox = new SceneCandidateToolbox({
        workspaceRoot,
        entryPath,
        authority,
        budget,
        signal: runtime.signal,
        ...(profile.toolTimeoutMs === undefined ? {} : { toolTimeoutMs: profile.toolTimeoutMs }),
        toolResultCharLimit: profile.toolResultCharLimit,
        allowClarification: clarificationAllowed,
        writeAuthority: state.authority,
        // 只在真实写盘前记录意图；没有写出的轮次不会留下 started 记录。
        beforeWrite: () =>
          writeDurableEffect(this.deps.stateRoot, factsExecution, {
            operationId: factsExecution.operationId,
            stepId,
            inputDigest,
            status: 'started',
            kind: 'fileWrite'
          })
      })
      const factsInput: WebGalSceneAgentInput = {
        mode: passMode === 'generate' ? 'generate' : 'repair',
        execution: factsExecution,
        ...(state.candidate === undefined ? {} : { candidate: state.candidate }),
        draft,
        skill: { id: skill.id, digest: skill.digest },
        ...(pass === 0 && execution.pendingReply?.reply.kind === 'revise'
          ? { authorRevisionActive: true }
          : {})
      }
      const facts = new SceneGenerationContextAssemblerImpl().assemble(factsInput)
      // 每轮重注入阶段、权威候选与本轮写入事实；模型据此决定继续写作、提交或报告阻塞。
      const authoritativePaths =
        state.candidateSnapshotId === undefined &&
        state.execution.candidateSnapshotId === undefined
          ? []
          : [entryPath]
      const passSystemPrompt = `${systemPrompt}${runStateBlock({
        budget,
        writtenFiles: authoritativePaths,
        executionMode: passMode
      })}`
      // 只有真正需要模型时才解析连接；已完成的副作用重放直接复用修订，不创建模型运行时。
      const agent = await createAgent()
      assertContextBudget(profile, agent, passSystemPrompt, facts, toolbox.tools)
      await runtime.publishProgress({
        step: state.step,
        attempt: state.execution.attempt + pass,
        budget: settledBudget(state.execution, budget, state.correctionCount),
        ...(state.candidateSnapshotId === undefined
          ? {}
          : { candidateSnapshotId: state.candidateSnapshotId })
      })
      let result: PiAgentRunResult | undefined
      let agentError: unknown
      try {
        result = await agent.run({
          systemPrompt: passSystemPrompt,
          prompt: facts,
          tools: toolbox.tools as readonly AgentTool[],
          signal: runtime.signal,
          identity: {
            executionId: execution.operationId,
            agentId: 'webgal-scene',
            runId: `${execution.operationId}:${pass}:${this.deps.nextId()}`
          },
          budget,
          progress: (event) => publisher.observe(event),
          toolExecution: 'sequential',
          thinkingLevel: 'off',
          hooks: {
            // 写入、提问或报告阻塞后本轮立即结束；三者由工具互斥，不会同时成立。
            finishTurn: async () =>
              toolbox.hasWritten || toolbox.hasAsked || toolbox.blocked !== undefined
                ? ({ action: 'end' } as const)
                : undefined,
            prepareRequest: async (context, signal) => {
              throwIfStopped(signal)
              assertRequestWithinWindow(profile, agent, context.context.messages)
              return undefined
            }
          }
        })
      } catch (error) {
        agentError = error
      }
      // 已成功写出的草稿先落地为不可变修订；取消、模型失败或迟到回执都不能让写入事实消失。
      let write: SceneWriteFact | undefined
      if (toolbox.hasWritten) {
        await this.settleWrittenDraft(
          state,
          toolbox.lastWrite!,
          factsExecution,
          stepId,
          inputDigest,
          budget,
          workspaceRoot,
          entryPath,
          runtime
        )
        write = toolbox.lastWrite
      } else if (toolbox.writeAttempts.length > 0) {
        // 写入工具没有成功返回：按当前草稿核对是否其实已落盘。
        write = await this.reconcileWriteAttempts(
          state,
          toolbox.writeAttempts,
          factsExecution,
          stepId,
          inputDigest,
          budget,
          workspaceRoot,
          entryPath,
          runtime
        )
      }
      if (agentError !== undefined) {
        throwIfStopped(runtime.signal)
        // 写后读取/修订归属/版本冲突属于待核对或冲突边界，不能被当成模型失败改写。
        if (this.isCandidateBoundaryFailure(agentError)) throw agentError
        const preserved = await this.preservedCandidateOutcome(
          state,
          '本轮模型执行失败。已保留最近一次写入并校验的候选，请说明要如何修改，或丢弃本次候选。'
        )
        if (preserved !== undefined) return preserved
        throw agentError
      }
      throwIfStopped(runtime.signal)
      if (result === undefined)
        throw new AppException({ code: ErrorCodes.internalError, msg: '生成流程没有返回结果' })
      if (result.status === 'cancelled')
        throw new AppException({ code: ErrorCodes.invalidRequest, msg: '模型执行已取消' })
      if (result.status === 'failed') {
        const preserved = await this.preservedCandidateOutcome(
          state,
          '本轮模型执行失败。已保留最近一次写入并校验的候选，请说明要如何修改，或丢弃本次候选。'
        )
        if (preserved !== undefined) return preserved
        throw modelFailure(result)
      }
      const blockedReason = toolbox.blocked
      if (blockedReason !== undefined) {
        const candidateSnapshotId =
          state.candidateSnapshotId ?? state.execution.candidateSnapshotId
        return this.decisions.blockedOutcome(
          state.execution,
          blockedReason,
          candidateSnapshotId,
          state.candidate
        )
      }
      if (toolbox.hasAsked) {
        const questions = toolbox.clarificationQuestions
        if (!questions)
          throw new AppException({ code: ErrorCodes.internalError, msg: '创作提问事实缺失' })
        return this.decisions.clarificationOutcome(state.execution, questions)
      }
      if (write === undefined) {
        if (pass > 0)
          return this.decisions.correctionOutcome(
            state.execution,
            state.candidateSnapshotId ?? state.execution.candidateSnapshotId,
            state.candidate,
            '本轮没有写入新的候选。',
            validationReportOf(state.candidate?.preview.validationReport)
          )
        throw new AppException({
          code: ErrorCodes.operationConflict,
          msg: '模型没有通过工具写入候选脚本',
          diagnosticCategory: 'completion'
        })
      }
      const candidate = state.candidate!
      const judgment = await this.decisions.judge(state.execution, candidate)
      const signature = issueSignature(judgment.report)
      const stalled = previousPass?.digest === write.digest && previousPass.signature === signature
      const decision = this.decisions.decideCandidate(state, candidate, judgment, stalled)
      if (decision?.kind === 'ready') {
        const completedPass = pass + 1
        const readyFacts: ReadyBoundaryFacts = {
          pass: completedPass,
          firstMode: initialMode,
          mode: 'repair',
          ...(baseCandidateSnapshotId === undefined ? {} : { baseCandidateSnapshotId }),
          reviewAccepted: state.reviewAccepted,
          ...(pending?.reply.kind === 'revise' || pending?.reply.kind === 'answers'
            ? { pendingReplyId: pending.replyId }
            : {})
        }
        // 最后一轮修正已可提交时，暂停仍先停在安全检查点，不把 ready 直接交给提交门。
        if (this.registry.pauseRequested(runtime, state))
          return pauseAtSafeCheckpoint({
            stateRoot: this.deps.stateRoot,
            runtime,
            state,
            workspaceRoot,
            entryPath,
            pass: completedPass,
            mode: 'repair',
            firstMode: initialMode,
            ...(baseCandidateSnapshotId === undefined ? {} : { baseCandidateSnapshotId }),
            ...(pending?.reply.kind === 'revise' || pending?.reply.kind === 'answers'
              ? { pendingReplyId: pending.replyId }
              : {})
          })
        return this.decisions.readyOutcome(
          state.execution,
          decision.candidateSnapshotId,
          decision.artifactValidation,
          readyFacts
        )
      }
      if (decision !== undefined) return decision
      previousPass = { digest: write.digest, signature }
      state.correctionCount += 1
      pass += 1
      passMode = 'repair'
      // 本轮已结算并重新判断，只有确实还要再调用模型时才停在这里。
      if (this.registry.pauseRequested(runtime, state)) {
        return pauseAtSafeCheckpoint({
          stateRoot: this.deps.stateRoot,
          runtime,
          state,
          workspaceRoot,
          entryPath,
          pass,
          mode: passMode,
          firstMode: initialMode,
          ...(baseCandidateSnapshotId === undefined ? {} : { baseCandidateSnapshotId }),
          ...(pending?.reply.kind === 'revise' || pending?.reply.kind === 'answers'
            ? { pendingReplyId: pending.replyId }
            : {})
        })
      }
    }
  }

  /**
   * 把已成功写出的草稿保存为不可变修订并记录完成事实。
   * 写后读回、修订保存或完成回执失败且结果不能证明时保留 started 待核对；
   * 调用方之后仍需按取消或模型状态收尾，不自动重写文件或提交。
   * @throws {SceneGenerationWriteOutcomeUnknown} 写后事实无法证明。
   */
  private async settleWrittenDraft(
    state: RunState,
    write: SceneWriteFact,
    execution: SceneGenerationExecution,
    stepId: string,
    inputDigest: string,
    budget: ExecutionBudget,
    workspaceRoot: string,
    entryPath: string,
    runtime: Pick<SceneGenerationRuntime, 'recordCandidateRevision' | 'publishProgress'>
  ): Promise<void> {
    // 取消后仍要读回已写出的文件；文件系统读取不传已中止信号，避免丢失写入事实。
    const readback = await this.readDraftAfterWrite(workspaceRoot, entryPath)
    if (readback.revision !== write.digest)
      throw new SceneGenerationWriteOutcomeUnknown(
        '候选回读摘要与工具回执不一致，已保留记录待核对'
      )
    await this.finishConfirmedWrite(state, execution, stepId, inputDigest, budget, runtime)
  }

  /**
   * 写入工具未成功返回时按磁盘事实核对本步：
   * 当前草稿已是某次写入意图的内容则按同一副作用补结算完成记录；
   * 明确未落盘才把该步 started 结算为失败；读回失败保留 started 待核对。
   * @throws {SceneGenerationWriteOutcomeUnknown} 无法证明本次写入结果。
   */
  private async reconcileWriteAttempts(
    state: RunState,
    attempts: readonly SceneWriteFact[],
    execution: SceneGenerationExecution,
    stepId: string,
    inputDigest: string,
    budget: ExecutionBudget,
    workspaceRoot: string,
    entryPath: string,
    runtime: Pick<SceneGenerationRuntime, 'recordCandidateRevision' | 'publishProgress'>
  ): Promise<SceneWriteFact | undefined> {
    const readback = await this.readDraftAfterWrite(workspaceRoot, entryPath)
    // 后一次意图优先：同一轮重试时以最终留在磁盘上的内容为准。
    const proven = [...attempts].reverse().find((attempt) => attempt.digest === readback.revision)
    if (proven !== undefined) {
      await this.finishConfirmedWrite(state, execution, stepId, inputDigest, budget, runtime)
      return proven
    }
    await failStartedDurableEffect(this.deps.stateRoot, execution, stepId, inputDigest)
    return undefined
  }

  /**
   * 写后读回；失败不把未证明的写入当成已失败或已完成。
   * @throws {SceneGenerationWriteOutcomeUnknown} 无法读取当前草稿。
   */
  private async readDraftAfterWrite(
    workspaceRoot: string,
    entryPath: string
  ): Promise<SceneDraftFacts> {
    try {
      return await readSceneDraft(workspaceRoot, entryPath)
    } catch (error) {
      throw new SceneGenerationWriteOutcomeUnknown('候选写入后无法读回，已保留记录待核对', error)
    }
  }

  /**
   * 已证明草稿落盘后保存不可变修订并补完成回执；失败保留 started 供核对。
   * 完成回执后先持久化 reading 检查点，再读取候选正文；读取中断时该边界仍可证明并继续。
   * @throws {SceneGenerationWriteOutcomeUnknown} 修订或完成回执未保存。
   * @throws {SceneGenerationReadInterrupted} 候选已保存但读取正文中断。
   */
  private async finishConfirmedWrite(
    state: RunState,
    execution: SceneGenerationExecution,
    stepId: string,
    inputDigest: string,
    budget: ExecutionBudget,
    runtime: Pick<SceneGenerationRuntime, 'recordCandidateRevision' | 'publishProgress'>
  ): Promise<void> {
    let revision: SceneGenerationCandidateRevisionRecord
    try {
      revision = await saveCandidateRevision({
        artifacts: this.deps.artifacts,
        runtime,
        execution,
        agentError: undefined
      })
    } catch (error) {
      throw new SceneGenerationWriteOutcomeUnknown('候选修订保存失败，已保留记录待核对', error)
    }
    state.candidateSnapshotId = revision.candidateSnapshotId
    state.wroteThisRun = true
    state.execution = { ...state.execution, candidateSnapshotId: revision.candidateSnapshotId }
    try {
      // 旧执行已被暂停或新代次接管时不能补写完成回执；保留 started 供待核对，不冒充本次结果。
      state.authority.assertActive()
      await finishCandidateEffect(this.deps.stateRoot, execution, stepId, inputDigest, revision, [])
    } catch (error) {
      throw new SceneGenerationWriteOutcomeUnknown('候选完成记录未保存，已保留记录待核对', error)
    }
    // 候选修订与完成回执都已持久化；先写 reading 边界，正文读取失败也不会丢失可继续事实。
    try {
      await runtime.publishProgress({
        step: 'reading',
        attempt: state.execution.attempt,
        budget: settledBudget(state.execution, budget, state.correctionCount),
        checkpointId: piReviewCheckpointId(execution.operationId, revision.candidateSnapshotId),
        candidateSnapshotId: revision.candidateSnapshotId
      })
    } catch (error) {
      throw new SceneGenerationWriteOutcomeUnknown(
        '候选已保存，但 reading 边界未保存，已保留记录待核对',
        error
      )
    }
    try {
      state.candidate = await this.deps.artifacts.readCandidate(
        execution,
        revision.candidateSnapshotId
      )
    } catch (error) {
      throw new SceneGenerationReadInterrupted(
        '候选修订已保存，但读取候选中断；可核对后继续重读，不需要重新调用模型或写入。',
        error
      )
    }
  }

  /**
   * 接受审阅：重读当前不可变候选并按候选内容重新判定。
   * 通过时返回可提交结果，由现有提交网关复验基线与幂等；仍可自动修正时按旧的接受语义继续修正。
   */
  async acceptReviewedCandidate(
    runtime: SceneGenerationRuntime,
    execution: SceneGenerationExecution
  ): Promise<SceneGenerationWorkflowOutcome> {
    const candidateSnapshotId = execution.candidateSnapshotId!
    const candidate = await this.deps.artifacts.readCandidate(execution, candidateSnapshotId)
    const judgment = this.decisions.judgeContent(execution, candidate)
    const report = judgment.report
    if (judgment.status === 'acceptable') {
      throwIfStopped(runtime.signal)
      const state: RunState = {
        execution,
        candidate,
        candidateSnapshotId,
        wroteThisRun: false,
        correctionCount: execution.budget.correctionsUsed,
        reviewAccepted: true,
        step: 'validating',
        signal: runtime.signal,
        authority: new SceneWriteAuthority(execution.operationId)
      }
      // 已受理暂停优先于正式提交：接受结果本身已是安全点，不写候选、不提交作品。
      if (this.registry.pauseRequested(runtime, state))
        return this.publisher.outcome(
          await pauseAtSafeCheckpoint({
            stateRoot: this.deps.stateRoot,
            runtime,
            state,
            workspaceRoot: execution.workspace!.rootDirectory,
            entryPath: `${execution.source.sceneDirectory}/${execution.source.entryFile}`,
            pass: 0,
            mode: 'repair',
            firstMode: 'repair',
            baseCandidateSnapshotId: candidateSnapshotId
          }),
          runtime,
          execution.budget
        )
      return this.publisher.outcome(
        this.decisions.readyOutcome(execution, candidateSnapshotId, report, {
          pass: 0,
          firstMode: 'repair',
          mode: 'repair',
          baseCandidateSnapshotId: candidateSnapshotId,
          reviewAccepted: true
        }),
        runtime,
        execution.budget
      )
    }
    if (
      judgment.status === 'correctable' &&
      !contextOnly(report) &&
      execution.budget.correctionsUsed < execution.policy.maxCorrections
    )
      return this.run(runtime, {
        mode: 'repair',
        reviewAccepted: true,
        resetCorrections: false
      })
    return this.publisher.outcome(
      this.decisions.correctionOutcome(
        execution,
        candidateSnapshotId,
        candidate,
        '接受时复核未通过。',
        report
      ),
      runtime,
      execution.budget
    )
  }

  /**
   * 模型失败时保留已经写入并绑定不可变修订的候选：重新读取当前工作区，
   * 通过领域判断则回到审阅，未通过则停在修正等待。没有候选或无法证明候选仍
   * 与工作区一致时返回 undefined 或进入待核对，不补造通过结论。
   */
  private async preservedCandidateOutcome(
    state: RunState,
    reason: string
  ): Promise<PassOutcome | undefined> {
    const candidateSnapshotId = state.candidateSnapshotId
    if (candidateSnapshotId === undefined) return undefined
    if (!state.wroteThisRun)
      // 本轮没有写出任何新候选。是否已经执行本次作者指令由持久写账本证明的
      // authorWrite 决定：重开后自动修正失败不能误称作者修改没有执行。
      return this.decisions.blockedOutcome(
        state.execution,
        unwrittenCandidateMessage(state),
        candidateSnapshotId,
        state.candidate
      )
    let candidate: SceneGenerationCandidate
    try {
      candidate = await this.deps.artifacts.readCandidate(state.execution, candidateSnapshotId)
    } catch (error) {
      throw new SceneGenerationWriteOutcomeUnknown(
        '模型失败后无法证明当前候选仍与工作区一致，已保留记录待核对',
        error
      )
    }
    state.candidate = candidate
    let judgment
    try {
      judgment = await this.decisions.judge(state.execution, candidate)
    } catch (error) {
      if (error instanceof SceneGenerationVersionConflict) throw error
      throw new SceneGenerationWriteOutcomeUnknown(
        '候选复核未完成，已保留记录待核对',
        error
      )
    }
    if (judgment.status === 'acceptable') {
      const decision = this.decisions.decideCandidate(state, candidate, judgment, false)
      if (decision !== undefined) return decision
    }
    return this.decisions.correctionOutcome(
      state.execution,
      candidateSnapshotId,
      candidate,
      reason,
      judgment.report
    )
  }

  private isCandidateBoundaryFailure(error: unknown): boolean {
    return (
      error instanceof SceneGenerationWriteOutcomeUnknown ||
      error instanceof SceneGenerationReadInterrupted ||
      error instanceof SceneGenerationVersionConflict
    )
  }
}

/**
 * 本轮没有写出新候选时，按已持久证明的作者写入事实说明保留版本与未执行步骤。
 * 只有完全没有作者写入证据时才沿用“本轮修改没有执行”。
 */
function unwrittenCandidateMessage(state: RunState): string {
  const authorWrite = state.authorWrite
  if (authorWrite !== undefined) {
    const label = authorWrite.kind === 'answers' ? '本次整组回答' : '本次修改要求'
    if (authorWrite.passes === 1)
      return `${label}已写入并保留为当前候选；自动修正尚未执行。模型调用失败，已写入的候选没有被替换；请重新说明修改要求，或丢弃本次候选。`
    return `${label}已写入，自动修正已保留 ${authorWrite.passes - 1} 轮结果；本轮模型调用失败，更进一步的修正未执行。请重新说明修改要求，或丢弃本次候选。`
  }
  if (state.reviewAccepted)
    return '已接受并保留当前候选；接受后的自动修正未执行。模型调用失败，当前候选没有被替换；请重新说明修改要求，或丢弃本次候选。'
  return '本轮修改没有执行，仍显示上一版候选。模型调用失败，本次候选没有被替换；请重新说明修改要求，或丢弃本次候选。'
}
