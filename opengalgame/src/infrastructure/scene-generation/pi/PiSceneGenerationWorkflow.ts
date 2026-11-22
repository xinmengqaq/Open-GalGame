import type {
  SceneGenerationExecution,
  SceneGenerationRuntime,
  SceneGenerationWorkflowOutcome
} from '@application/scene-generation/models/SceneGenerationExecution'
import type { ForkSceneGenerationDTO } from '@application/scene-generation/dto/SceneGenerationDTO'
import type {
  SceneGenerationWorkflow,
  SceneGenerationWorkflowCapabilities
} from '@application/scene-generation/ports/SceneGenerationWorkflow'
import type { SceneGenerationWorkflowControl } from '@application/scene-generation/ports/SceneGenerationWorkflowControl'
import { SceneGenerationWriteOutcomeUnknown } from '@application/scene-generation/errors/SceneGenerationWriteOutcomeUnknown'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { throwIfStopped } from '@infrastructure/ai/execution/executionErrors'
import { readDurableEffects } from '@infrastructure/workflow/execution/durableEffect'
import { piReviewCheckpointId } from '@infrastructure/scene-generation/workflow/piReviewCheckpoint'
import { clearPauseBoundary } from './PiPauseBoundary'
import { PiSceneCandidateDecisions } from './PiSceneCandidateDecisions'
import { PiSceneGenerationLoop } from './PiSceneGenerationLoop'
import { PiSceneGenerationRecovery } from './PiSceneGenerationRecovery'
import { PiSceneOutcomePublisher } from './PiSceneOutcomePublisher'
import {
  SceneWriteAuthority,
  PiSceneExecutionRegistry,
  type PiSceneGenerationWorkflowDependencies
} from './PiSceneGenerationTypes'
import {
  requireForkSource,
  validateExecution,
  validateForkExecution
} from './PiSceneGenerationContract'

/**
 * Pi 场景适配器：真实 Pi 工具循环生成候选，宿主读回、解析与领域校验后
 * 发布不可变修订并等待审阅；接受、修改与丢弃按原有审阅边界在 Pi 下执行。
 * 安全暂停持久化可恢复边界；显式继续先核对身份、输入、草稿、修订与副作用再续做。
 * 历史分叉复制已证明的草稿、输入与候选修订到新分支，不重放来源模型轮次。
 */
export class PiSceneGenerationWorkflow
  implements SceneGenerationWorkflow, SceneGenerationWorkflowControl
{
  private readonly registry = new PiSceneExecutionRegistry()
  private readonly decisions: PiSceneCandidateDecisions
  private readonly publisher: PiSceneOutcomePublisher
  private readonly loop: PiSceneGenerationLoop
  private readonly recovery: PiSceneGenerationRecovery

  constructor(private readonly deps: PiSceneGenerationWorkflowDependencies) {
    this.decisions = new PiSceneCandidateDecisions(deps)
    this.publisher = new PiSceneOutcomePublisher(deps.stateRoot)
    this.loop = new PiSceneGenerationLoop(deps, this.registry, this.decisions, this.publisher)
    this.recovery = new PiSceneGenerationRecovery(
      deps,
      this.registry,
      this.decisions,
      this.publisher,
      this.loop
    )
  }

  /** 可处理候选审阅回复、安全检查点暂停、显式继续与已证明边界的历史分叉。 */
  capabilities(): SceneGenerationWorkflowCapabilities {
    return { resume: true, pause: true, continueInteraction: true, fork: true }
  }

  /** 失败/取消终结时仍保留操作边界；应用只把它当作不透明标识持久化。 */
  checkpointIdFor(execution: SceneGenerationExecution): string {
    return piReviewCheckpointId(execution.operationId, execution.candidateSnapshotId)
  }

  /**
   * 执行一次生成或修复重跑；候选发布前必须由宿主读回并通过领域校验。
   * @throws {AppException} 输入、模型、工具、读取或校验失败；取消信号实际传递。
   */
  async executeGeneration(
    runtime: SceneGenerationRuntime
  ): Promise<SceneGenerationWorkflowOutcome> {
    const execution = validateExecution(runtime.execution)
    throwIfStopped(runtime.signal)
    return this.loop.run(runtime, {
      mode: execution.repairSource === undefined ? 'generate' : 'repair',
      reviewAccepted: false,
      resetCorrections: false
    })
  }

  /** 人工写入后的继续、安全暂停后的显式继续或写后读取边界。 */
  resumeGeneration(runtime: SceneGenerationRuntime): Promise<SceneGenerationWorkflowOutcome> {
    return this.recovery.resumeGeneration(runtime)
  }

  /** 应用已持久接受的人工回复在同一操作、线程与分支内续做。 */
  continueInteraction(runtime: SceneGenerationRuntime): Promise<SceneGenerationWorkflowOutcome> {
    return this.recovery.continueInteraction(runtime)
  }

  /**
   * 从已证明的 Pi 历史边界复制草稿、输入与候选修订到新分支。
   * 无输入/决定变化时只重新判定复制出的候选，不调用模型；
   * 有变化时从复制边界做一次新修复，不重放来源已完成轮次。
   * @throws {AppException | SceneGenerationWriteOutcomeUnknown} 来源不可证明或已有未知回执。
   */
  async forkGeneration(
    runtime: SceneGenerationRuntime,
    request: ForkSceneGenerationDTO
  ): Promise<SceneGenerationWorkflowOutcome> {
    const execution = validateForkExecution(runtime.execution, request)
    // 建分叉时已从来源检查点与不可变修订捕获证据；重开只核对证据、当前分叉身份
    // 和 Git 归属。证据与捕获标记均缺失时不能证明创建时来源，保持现场待核对，
    // 不读取来源操作后来推进到的当前检查点或候选。
    const evidence = this.deps.forkSourceEvidence
    if (!evidence)
      throw new AppException({
        code: ErrorCodes.internalError,
        msg: '分叉来源证据未装配，不能核对分叉来源'
      })
    const verification = await evidence.verify(execution)
    if (!verification.ok)
      throw new SceneGenerationWriteOutcomeUnknown(
        `分叉来源证据不足，已保留现场待核对：${verification.reason}`
      )
    requireForkSource(execution, verification.evidence, request)
    // 分叉执行留下的副作用必须按已证明的状态续作：已有本次候选的完成回执时只重新判定，
    // 不复制、不重跑模型；结果不明或来源不可归属时保留现场，不当作新分叉重来。
    const effects = await readDurableEffects(this.deps.stateRoot, execution)
    if (effects.length > 0) {
      if (effects.some((effect) => effect.status === 'started' || effect.status === 'unknown'))
        throw new SceneGenerationWriteOutcomeUnknown('分叉执行写入结果尚未确认，已保留记录待核对')
      const candidateSnapshotId = execution.candidateSnapshotId
      const completed = effects.filter(
        (effect) => effect.kind === 'fileWrite' && effect.status === 'completed'
      )
      const belongsToCandidate =
        candidateSnapshotId !== undefined &&
        completed.some((effect) => effect.candidateRevision === candidateSnapshotId)
      if (
        belongsToCandidate &&
        completed.every((effect) => effect.operationId === execution.operationId)
      )
        return this.recovery.rejudgeBoundCandidate(
          runtime,
          execution,
          '分叉候选复核未通过。'
        )
      throw new SceneGenerationWriteOutcomeUnknown('分叉执行已有未证明的副作用记录，已保留记录待核对')
    }
    const candidateSnapshotId = execution.candidateSnapshotId
    if (candidateSnapshotId === undefined)
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '分叉边界没有可复制的候选修订'
      })
    // readCandidate 同时核对当前工作区与不可变修订逐字节一致。
    const candidate = await this.deps.artifacts.readCandidate(execution, candidateSnapshotId)
    if (!request.inputChanges && !(request.decisionChanges?.length ?? 0)) {
      const state = {
        execution,
        candidate,
        candidateSnapshotId,
        wroteThisRun: false,
        correctionCount: execution.budget.correctionsUsed,
        reviewAccepted: false,
        step: 'validating' as const,
        signal: runtime.signal,
        authority: new SceneWriteAuthority(execution.operationId)
      }
      const judgment = await this.decisions.judge(execution, candidate)
      const decision = this.decisions.decideCandidate(state, candidate, judgment, false)
      return this.publisher.outcome(
        decision ??
          this.decisions.correctionOutcome(
            execution,
            candidateSnapshotId,
            candidate,
            '分叉复制的候选仍需修正，请在本分支提出修改或丢弃。',
            judgment.report
          ),
        runtime,
        execution.budget
      )
    }
    // 新输入或新决定是新分支未完成的工作；只从复制出的候选开始一次修复。
    return this.loop.run(runtime, {
      mode: 'repair',
      reviewAccepted: false,
      resetCorrections: false
    })
  }

  /**
   * 活跃运行只在两次模型往返之间暂停；没有活动运行时不伪造中断。
   * 持久暂停意图已由应用写入，恢复时仍以持久边界为准。
   */
  async requestPauseAtSafeCheckpoint(execution: SceneGenerationExecution): Promise<void> {
    this.registry.requestPause(execution.operationId)
  }

  /** 正式作品提交成功后不再需要可提交结果留下的暂停边界。 */
  async clearPauseBoundary(execution: SceneGenerationExecution): Promise<void> {
    await clearPauseBoundary(this.deps.stateRoot, execution)
  }
}
