import type {
  SceneGenerationCandidate,
  SceneGenerationExecution,
  SceneGenerationRuntime,
  SceneGenerationWorkflowOutcome
} from '@application/scene-generation/models/SceneGenerationExecution'
import { SceneGenerationWriteOutcomeUnknown } from '@application/scene-generation/errors/SceneGenerationWriteOutcomeUnknown'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { throwIfStopped } from '@infrastructure/ai/execution/executionErrors'
import { readDurableEffects } from '@infrastructure/workflow/execution/durableEffect'
import { piReviewCheckpointId } from '@infrastructure/scene-generation/workflow/piReviewCheckpoint'
import { readPauseBoundary, type PiPauseBoundary } from './PiPauseBoundary'
import { issueSignature } from './PiSceneGenerationSupport'
import { replayReplyEffects } from './PiSceneGenerationEffects'
import {
  requirePauseBoundary,
  pauseAtSafeCheckpoint
} from './PiSceneGenerationPause'
import {
  validateContinuation,
  validateExecution
} from './PiSceneGenerationContract'
import {
  SceneWriteAuthority,
  type PiSceneExecutionRegistry,
  type PiSceneGenerationWorkflowDependencies,
  type ReadyBoundaryFacts
} from './PiSceneGenerationTypes'
import type { PiSceneCandidateDecisions } from './PiSceneCandidateDecisions'
import type { PiSceneGenerationLoop } from './PiSceneGenerationLoop'
import type { PiSceneOutcomePublisher } from './PiSceneOutcomePublisher'

/**
 * 人工等待、暂停边界与写后中断的恢复路径。所有续做都先核对持久身份、输入、草稿、
 * 修订与副作用；只复用可证明事实，不调用模型猜测旧写入。
 */
export class PiSceneGenerationRecovery {
  constructor(
    private readonly deps: PiSceneGenerationWorkflowDependencies,
    private readonly registry: PiSceneExecutionRegistry,
    private readonly decisions: PiSceneCandidateDecisions,
    private readonly publisher: PiSceneOutcomePublisher,
    private readonly loop: PiSceneGenerationLoop
  ) {}

  /**
   * 人工写入后的继续或安全暂停后的显式继续。
   * 有 Pi 检查点时先核对暂停边界、代次、输入、草稿、修订和副作用；
   * 没有检查点时才走人工修改后的重新校验。不自动调用模型，调用方必须先取得用户明确继续。
   */
  async resumeGeneration(runtime: SceneGenerationRuntime): Promise<SceneGenerationWorkflowOutcome> {
    const execution = runtime.execution
    // 暂停边界只由安全暂停写入。存在边界时先核对代次和持久事实，再决定走回复还是普通续做。
    const storedBoundary =
      execution.checkpointId === undefined
        ? null
        : await readPauseBoundary(this.deps.stateRoot, execution).catch(() => null)
    const boundaryApplies =
      storedBoundary !== null &&
      storedBoundary.generation <= execution.attempt &&
      (storedBoundary.pendingReplyId === undefined
        ? execution.pendingReply === undefined
        : execution.pendingReply?.replyId === storedBoundary.pendingReplyId)
    if (boundaryApplies && storedBoundary !== null) {
      const boundary = await this.requirePauseBoundary(execution)
      const checked = validateExecution(execution)
      if (checked.pendingReply !== undefined) {
        // 提出修改/整组回答保留了原回复：先按编辑账本核对轮次，再交给既有回复续跑。
        const replay = await replayReplyEffects(
          this.deps.stateRoot,
          checked,
          checked.pendingReply.reply.kind === 'answers' ? 'answers' : 'revise'
        )
        if (
          replay.passes !== boundary.pass ||
          (replay.candidateSnapshotId ?? undefined) !== (boundary.candidateSnapshotId ?? undefined)
        )
          throw new SceneGenerationWriteOutcomeUnknown(
            '候选修订与暂停边界不一致，已保留记录待核对'
          )
        return this.continueInteraction(runtime)
      }
      return this.resumeFromBoundary(runtime, checked, boundary)
    }
    if (execution.pendingReply !== undefined) return this.continueInteraction(runtime)
    if (execution.checkpointId !== undefined) {
      if (this.isPostwriteReadingBoundary(execution))
        return this.resumePostwriteReading(runtime, execution)
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '当前检查点没有可核对的安全暂停边界'
      })
    }
    return this.rejudgeBoundCandidate(runtime, execution, '人工修改后复核未通过。')
  }

  /**
   * 从已绑定的不可变候选重新判定，不调用模型、不写入候选。
   * 用于人工修改后的继续，以及分叉写入已结算后的续作。
   */
  async rejudgeBoundCandidate(
    runtime: SceneGenerationRuntime,
    execution: SceneGenerationExecution,
    rejectReason: string
  ): Promise<SceneGenerationWorkflowOutcome> {
    const checked = validateExecution(execution)
    if (!checked.candidateSnapshotId)
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '当前操作没有可复核的候选修订'
      })
    throwIfStopped(runtime.signal)
    const candidate = await this.deps.artifacts.readCandidate(checked, checked.candidateSnapshotId)
    const judgment = await this.decisions.judge(checked, candidate)
    const state = {
      execution: checked,
      candidate,
      candidateSnapshotId: checked.candidateSnapshotId,
      wroteThisRun: false,
      correctionCount: checked.budget.correctionsUsed,
      reviewAccepted: false,
      step: 'validating' as const,
      signal: runtime.signal,
      authority: new SceneWriteAuthority(checked.operationId)
    }
    const decision = this.decisions.decideCandidate(state, candidate, judgment, false)
    if (decision !== undefined) return this.publisher.outcome(decision, runtime, checked.budget)
    return this.publisher.outcome(
      this.decisions.correctionOutcome(
        checked,
        checked.candidateSnapshotId,
        candidate,
        rejectReason,
        judgment.report
      ),
      runtime,
      checked.budget
    )
  }

  /**
   * 写后读取中断留下的边界：检查点必须绑定当前候选修订，且阶段为 reading 或
   * 明确标记 readInterrupted。旧审阅/暂停检查点不能冒充该边界。
   */
  isPostwriteReadingBoundary(execution: SceneGenerationExecution): boolean {
    const candidateSnapshotId = execution.candidateSnapshotId
    if (candidateSnapshotId === undefined) return false
    if (
      execution.checkpointId !==
      piReviewCheckpointId(execution.operationId, candidateSnapshotId)
    )
      return false
    return execution.interruptReason === 'readInterrupted' || execution.step === 'reading'
  }

  /**
   * 写后读取中断的安全续做：只核对写账本、不可变修订与当前草稿，然后重读候选并重新判断。
   * 不调用模型、不写候选、不提交作品；需要继续自动修正时停在人工修改入口。
   */
  private async resumePostwriteReading(
    runtime: SceneGenerationRuntime,
    execution: SceneGenerationExecution
  ): Promise<SceneGenerationWorkflowOutcome> {
    if (
      execution.state === 'failed' ||
      execution.state === 'cancelled' ||
      execution.state === 'succeeded'
    )
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '操作已结束，不能从写后读取边界继续'
      })
    throwIfStopped(runtime.signal)
    const checked = validateExecution(execution)
    const candidateSnapshotId = checked.candidateSnapshotId!
    const effects = await readDurableEffects(this.deps.stateRoot, checked)
    // 写后边界只允许在全部副作用已结算时重读；不明回执交给待核对，不能当普通续做。
    if (effects.some((effect) => effect.status !== 'completed'))
      throw new SceneGenerationWriteOutcomeUnknown('副作用结果尚未确认，已保留记录待核对')
    const proven = effects.some(
      (effect) =>
        effect.kind === 'fileWrite' &&
        effect.status === 'completed' &&
        effect.candidateRevision === candidateSnapshotId &&
        effect.inputDigest.length > 0
    )
    if (!proven)
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '缺少可证明的候选写入记录，已保留记录待核对'
      })
    // readCandidate 同时核对不可变修订与本操作当前草稿逐字节一致。
    const candidate = await this.deps.artifacts.readCandidate(checked, candidateSnapshotId)
    const state = {
      execution: checked,
      candidate,
      candidateSnapshotId,
      wroteThisRun: false,
      correctionCount: checked.budget.correctionsUsed,
      reviewAccepted: false,
      step: 'validating' as const,
      signal: runtime.signal,
      authority: new SceneWriteAuthority(checked.operationId)
    }
    const judgment = await this.decisions.judge(checked, candidate)
    const decision = this.decisions.decideCandidate(state, candidate, judgment, false)
    if (decision !== undefined) return this.publisher.outcome(decision, runtime, checked.budget)
    // 自动修正会再次调用模型；写后读取续做只恢复到人工修改边界。
    return this.publisher.outcome(
      this.decisions.correctionOutcome(
        checked,
        candidateSnapshotId,
        candidate,
        '候选已重新读取，但仍需修正。请说明要如何修改，或丢弃本次候选。',
        judgment.report
      ),
      runtime,
      checked.budget
    )
  }

  /**
   * 从已核对的暂停边界继续原操作：有候选时先按当前修订重新判断，
   * 能审阅就回到等待/提交，需要自动修正才从下一轮续做一次。
   */
  private async resumeFromBoundary(
    runtime: SceneGenerationRuntime,
    execution: SceneGenerationExecution,
    boundary: PiPauseBoundary
  ): Promise<SceneGenerationWorkflowOutcome> {
    throwIfStopped(runtime.signal)
    let candidate: SceneGenerationCandidate | undefined
    let previousPass: { digest: string; signature: string } | undefined
    // 边界可能停在已接受候选而还没有本轮写入（pass=0）；有候选就重新判断，
    // 不能因为轮号为零就重新调用模型或遗漏 reviewAccepted。
    if (boundary.pass > 0 && boundary.candidateSnapshotId === undefined)
      throw new SceneGenerationWriteOutcomeUnknown('暂停边界缺少候选修订，已保留记录待核对')
    if (boundary.candidateSnapshotId !== undefined) {
      candidate = await this.deps.artifacts.readCandidate(
        execution,
        boundary.candidateSnapshotId
      )
      const judgment = await this.decisions.judge(execution, candidate)
      const state = {
        execution,
        candidate,
        candidateSnapshotId: boundary.candidateSnapshotId,
        wroteThisRun: false,
        correctionCount: execution.budget.correctionsUsed,
        reviewAccepted: boundary.reviewAccepted,
        step: 'validating' as const,
        signal: runtime.signal,
        authority: new SceneWriteAuthority(execution.operationId)
      }
      const decision = this.decisions.decideCandidate(state, candidate, judgment, false)
      if (decision?.kind === 'ready') {
        const resumeFacts: ReadyBoundaryFacts = {
          pass: boundary.pass,
          firstMode: boundary.firstMode,
          mode: boundary.mode,
          ...(boundary.baseCandidateSnapshotId === undefined
            ? {}
            : { baseCandidateSnapshotId: boundary.baseCandidateSnapshotId }),
          reviewAccepted: boundary.reviewAccepted,
          ...(boundary.pendingReplyId === undefined
            ? {}
            : { pendingReplyId: boundary.pendingReplyId })
        }
        if (this.registry.pauseRequested(runtime, state))
          return this.publisher.outcome(
            await pauseAtSafeCheckpoint({
              stateRoot: this.deps.stateRoot,
              runtime,
              state,
              workspaceRoot: execution.workspace!.rootDirectory,
              entryPath: `${execution.source.sceneDirectory}/${execution.source.entryFile}`,
              pass: boundary.pass,
              mode: boundary.mode,
              firstMode: boundary.firstMode,
              ...(boundary.baseCandidateSnapshotId === undefined
                ? {}
                : { baseCandidateSnapshotId: boundary.baseCandidateSnapshotId }),
              ...(boundary.pendingReplyId === undefined
                ? {}
                : { pendingReplyId: boundary.pendingReplyId })
            }),
            runtime,
            execution.budget
          )
        return this.publisher.outcome(
          this.decisions.readyOutcome(
            execution,
            decision.candidateSnapshotId,
            decision.artifactValidation,
            resumeFacts
          ),
          runtime,
          execution.budget
        )
      }
      if (decision !== undefined)
        return this.publisher.outcome(decision, runtime, execution.budget)
      previousPass = {
        digest: boundary.draftRevision,
        signature: issueSignature(judgment.report)
      }
    }
    return this.loop.run(runtime, {
      mode: boundary.firstMode,
      reviewAccepted: boundary.reviewAccepted,
      resetCorrections: false,
      resume: {
        pass: boundary.pass,
        mode: boundary.mode,
        ...(boundary.candidateSnapshotId === undefined
          ? {}
          : { candidateSnapshotId: boundary.candidateSnapshotId }),
        ...(previousPass === undefined ? {} : { previousPass })
      }
    })
  }

  /**
   * 消费应用已持久接受的审阅回复：接受后按当前候选重新校验并交给提交边界；
   * 提出修改时在同一候选工作区执行一次修改轮，成功后重新进入审阅。
   * @throws {AppException} 回复身份与当前候选不一致或执行失败；等待记录不被改写。
   */
  async continueInteraction(
    runtime: SceneGenerationRuntime
  ): Promise<SceneGenerationWorkflowOutcome> {
    // 整组回答写后崩溃：先按写账本证明本次写入是否已经完成，再决定是否允许带候选续跑。
    // 只有当前待回复是整组回答时才读取账本；结果不明会在这里停止，不进入模型。
    const answeredWriteReplay =
      runtime.execution.pendingReply?.reply.kind === 'answers'
        ? await replayReplyEffects(this.deps.stateRoot, runtime.execution, 'answers')
        : undefined
    const execution = validateContinuation(runtime.execution, answeredWriteReplay)
    const reply = execution.pendingReply!.reply
    if (reply.kind === 'accept')
      return this.loop.acceptReviewedCandidate(runtime, execution)
    if (reply.kind === 'revise') {
      // 阻塞等待可能没有候选；作者补充要求后仍是首次生成，不能伪装成修复起点。
      const hasCandidate =
        execution.candidateSnapshotId !== undefined || execution.repairSource !== undefined
      return this.loop.run(runtime, {
        mode: hasCandidate ? 'repair' : 'generate',
        reviewAccepted: false,
        resetCorrections: true
      })
    }
    if (reply.kind === 'answers')
      // 整组回答是新的授权输入：仍在原操作、线程与分支内首次生成候选，不沿用题组前的输入摘要。
      return this.loop.run(runtime, {
        mode: 'generate',
        reviewAccepted: false,
        resetCorrections: false,
        ...(answeredWriteReplay === undefined ? {} : { answeredWriteReplay })
      })
    throw new AppException({
      code: ErrorCodes.invalidRequest,
      msg: '当前生成只支持接受、提出修改、回答整组问题或丢弃候选'
    })
  }

  private requirePauseBoundary(execution: SceneGenerationExecution): Promise<PiPauseBoundary> {
    return requirePauseBoundary(
      this.deps.stateRoot,
      (checked, candidateSnapshotId) =>
        this.deps.artifacts.readCandidate(checked, candidateSnapshotId),
      execution
    )
  }
}
