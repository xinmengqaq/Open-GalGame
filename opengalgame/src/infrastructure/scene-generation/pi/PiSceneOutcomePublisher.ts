import type {
  SceneGenerationExecution,
  SceneGenerationRuntime,
  SceneGenerationWorkflowOutcome,
  SceneGenerationWorkflowProgress
} from '@application/scene-generation/models/SceneGenerationExecution'
import { SceneGenerationReadInterrupted } from '@application/scene-generation/errors/SceneGenerationReadInterrupted'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { readSceneDraft } from './SceneCandidateToolbox'
import {
  clearPauseBoundary,
  writePauseBoundary
} from './PiPauseBoundary'
import { candidateInputDigest } from '@infrastructure/scene-generation/workflow/graph/candidateRevision'
import { piReviewCheckpointId } from '@infrastructure/scene-generation/workflow/piReviewCheckpoint'
import type { PassOutcome, RunState } from './PiSceneGenerationTypes'

/**
 * 工作流终态发布：等待/题组/阻塞先清理旧暂停边界，可提交结果先落安全边界；
 * 执行记录的最终写入仍归应用运行编排。
 */
export class PiSceneOutcomePublisher {
  constructor(private readonly stateRoot: string) {}

  /**
   * 把可提交结果落成暂停边界：保留候选、reviewAccepted 与轮次事实。
   * 暂停已受理时应用会在提交门前消费它；未受理时提交成功后清除。
   * @throws {AppException | SceneGenerationWriteOutcomeUnknown} 工作区或边界无法持久化。
   */
  async persistReadyBoundary(
    execution: SceneGenerationExecution,
    body: Extract<PassOutcome, { kind: 'ready' }>
  ): Promise<void> {
    if (!execution.workspace)
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '可提交结果缺少候选工作区，不能建立暂停边界'
      })
    const entryPath = `${execution.source.sceneDirectory}/${execution.source.entryFile}`
    const draft = await readSceneDraft(execution.workspace.rootDirectory, entryPath)
    const facts: SceneGenerationExecution = {
      ...execution,
      candidateSnapshotId: body.candidateSnapshotId
    }
    await writePauseBoundary(this.stateRoot, {
      projectId: execution.projectId,
      operationId: execution.operationId,
      threadId: execution.threadId,
      branchId: execution.branchId,
      checkpointId: body.checkpointId,
      generation: execution.attempt,
      pass: body.resume.pass,
      firstMode: body.resume.firstMode,
      mode: body.resume.mode,
      ...(body.resume.baseCandidateSnapshotId === undefined
        ? {}
        : { baseCandidateSnapshotId: body.resume.baseCandidateSnapshotId }),
      candidateSnapshotId: body.candidateSnapshotId,
      inputDigest: candidateInputDigest(body.resume.mode, facts),
      draftRevision: draft.revision,
      reviewAccepted: body.resume.reviewAccepted,
      publishedCandidates:
        execution.publishedCandidates?.map((item) => item.candidateSnapshotId) ?? [],
      ...(body.resume.pendingReplyId === undefined
        ? {}
        : { pendingReplyId: body.resume.pendingReplyId })
    })
  }

  /**
   * 失败/取消也发布一次操作边界：保留检查点与候选身份，历史不因缺少检查点而消失。
   * 写后读取中断额外保留 reading 阶段；不在失败时伪造候选或校验通过。
   */
  async publishFailureBoundary(
    runtime: SceneGenerationRuntime,
    state: RunState,
    failure: unknown,
    budget: SceneGenerationExecution['budget']
  ): Promise<void> {
    const candidateSnapshotId =
      state.candidateSnapshotId ?? state.execution.candidateSnapshotId
    await runtime.publishProgress({
      step: failure instanceof SceneGenerationReadInterrupted ? 'reading' : undefined,
      attempt: state.execution.attempt,
      budget,
      live: undefined,
      checkpointId: piReviewCheckpointId(runtime.execution.operationId, candidateSnapshotId),
      ...(candidateSnapshotId === undefined ? {} : { candidateSnapshotId })
    })
  }

  /** 先把结算后的预算写回执行记录，再返回工作流结果。 */
  async outcome(
    body: PassOutcome,
    runtime: SceneGenerationRuntime,
    settled: SceneGenerationExecution['budget']
  ): Promise<SceneGenerationWorkflowOutcome> {
    // 到达审阅/等待边界后旧暂停边界失效；可提交结果先持久化安全边界，
    // 由提交门在不可撤销提交前决定是否消费，成功提交后再清除。
    if (
      body.kind === 'waiting' ||
      body.kind === 'questions' ||
      body.kind === 'blocked'
    )
      await clearPauseBoundary(this.stateRoot, runtime.execution).catch(() => undefined)
    if (body.kind === 'ready')
      await this.persistReadyBoundary(runtime.execution, body)
    const decisionWait =
      body.kind === 'waiting' || body.kind === 'questions' || body.kind === 'blocked'
    const progress: SceneGenerationWorkflowProgress = {
      // 等待时状态与交互必须和检查点、候选一起落盘；step 留空，由 state 投影等待阶段。
      ...(decisionWait
        ? { state: 'waiting' as const, step: undefined, interaction: body.interaction }
        : body.kind === 'interrupted'
          ? {}
          : { step: body.step }),
      attempt: body.attempt,
      budget: settled,
      live: undefined,
      checkpointId: body.checkpointId,
      ...(body.kind === 'waiting' || body.kind === 'ready' || body.kind === 'blocked'
        ? {
            ...(body.candidateSnapshotId === undefined
              ? {}
              : { candidateSnapshotId: body.candidateSnapshotId }),
            ...(body.kind === 'blocked' || body.artifactValidation === undefined
              ? {}
              : { artifactValidation: body.artifactValidation })
          }
        : {})
    }
    await runtime.publishProgress(progress)
    if (body.kind === 'ready')
      return {
        state: 'ready',
        checkpointId: body.checkpointId,
        candidateSnapshotId: body.candidateSnapshotId,
        budget: settled
      }
    if (body.kind === 'questions')
      // 题组等待不携带候选或校验报告，避免被投影成可预览或已通过校验。
      return {
        state: 'waiting',
        interaction: body.interaction,
        checkpointId: body.checkpointId,
        budget: settled
      }
    if (body.kind === 'waiting')
      return {
        state: 'waiting',
        interaction: body.interaction,
        candidateSnapshotId: body.candidateSnapshotId,
        checkpointId: body.checkpointId,
        budget: settled
      }
    if (body.kind === 'blocked')
      return {
        state: 'waiting',
        interaction: body.interaction,
        ...(body.candidateSnapshotId === undefined
          ? {}
          : { candidateSnapshotId: body.candidateSnapshotId }),
        checkpointId: body.checkpointId,
        budget: settled
      }
    return {
      state: 'interrupted',
      interruptReason: 'paused',
      ...(body.candidateSnapshotId === undefined
        ? {}
        : { candidateSnapshotId: body.candidateSnapshotId }),
      checkpointId: body.checkpointId,
      budget: settled
    }
  }
}
