import type {
  ResumeSceneGenerationDTO,
  SceneGenerationRecoveryScopeDTO,
  SceneGenerationScopeDTO
} from '../../dto/SceneGenerationDTO'
import type {
  SceneGenerationExecution,
  SceneGenerationCommitState
} from '../../models/SceneGenerationExecution'
import type { SceneGenerationStatusVO } from '../../vo/SceneGenerationVO'
import type {
  SceneGenerationRenderStatusVO,
  SceneGenerationVerificationResultVO
} from '../../vo/SceneGenerationRenderVO'
import type { SceneGenerationWorkflowCapabilities } from '../../ports/SceneGenerationWorkflow'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { canResumeInterruptedSceneGeneration, canResumePausedSceneGeneration } from '@domain/scene-generation/services/validateSceneGenerationReply'
import { toRenderStatusVO } from '../../mapping/SceneGenerationRenderProjection'
import { operationKey, threadKey } from '../../policies/SceneGenerationIdempotency'
import {
  canVerifyUnknownResult,
  hasCommittedCleanupPending,
  unfinishedRecoveryIssue
} from '../../policies/SceneGenerationRecoveryBoundary'
import type { SceneGenerationServiceContext } from './SceneGenerationServiceContext'
import type { ActiveSceneGeneration } from './SceneGenerationCoordinator'

export interface SceneGenerationResumeGateway {
  resumeSceneGeneration(request: SceneGenerationScopeDTO): Promise<SceneGenerationStatusVO>
  resumeAuthorizedPause(request: SceneGenerationScopeDTO): Promise<SceneGenerationStatusVO>
}

export class ResumeSceneGenerationFromCheckpointUseCase {
  constructor(
    private readonly context: SceneGenerationServiceContext,
    private readonly generation: SceneGenerationResumeGateway
  ) {}

  async resumeSceneGeneration(
    request: ResumeSceneGenerationDTO
  ): Promise<SceneGenerationRenderStatusVO> {
    const execution = await this.context.coordinator.requireExecution(request)
    if (
      execution.threadId !== request.threadId ||
      execution.branchId !== request.branchId ||
      execution.checkpointId !== request.checkpointId ||
      (execution.candidateSnapshotId ?? undefined) !== request.candidateSnapshotId
    ) {
      throw new AppException({ code: ErrorCodes.operationConflict, msg: '恢复身份已过期' })
    }
    if (execution.state === 'cancelled' || execution.cancellationRequested === true) {
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '操作已取消，不能继续执行'
      })
    }
    if (
      execution.interruptReason === 'commitUnknown' ||
      execution.interruptReason === 'candidateConflict' ||
      execution.interruptReason === 'writeUnknown'
    ) {
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '当前中断不能按普通检查点恢复'
      })
    }
    const capabilities = this.context.deps.workflow.capabilities()
    // 已持久回复属于继续能力，不是检查点续跑；按回复资格重放，不要求 resume 能力。
    if (execution.pendingReply) {
      if (!capabilities.continueInteraction) {
        throw new AppException({
          code: ErrorCodes.operationConflict,
          msg: '当前构建尚未启用该交互回复，等待保持不变'
        })
      }
      const replyCheckpoint = await this.context.deps.history.readCheckpoint(request)
      const paused = execution.interruptReason === 'paused'
      // 暂停期间保留的待执行回复不是新的回复边界：必须绑定可继续的暂停检查点，
      // 不能借 canReply 绕过暂停授权；普通崩溃回复仍按 canReply 继续。
      if (paused) {
        if (replyCheckpoint.view.canContinue !== true) {
          throw new AppException({
            code: ErrorCodes.operationConflict,
            msg: '暂停边界缺失或已变化，不能继续'
          })
        }
      } else if (
        execution.pendingReply.reply.kind !== 'discard' &&
        replyCheckpoint.view.canReply !== true
      ) {
        throw new AppException({
          code: ErrorCodes.operationConflict,
          msg: '当前等待缺少可靠回复依据'
        })
      }
      const status = paused
        ? await this.generation.resumeAuthorizedPause(request)
        : await this.generation.resumeSceneGeneration(request)
      const resumed = await this.context.deps.executions.readExecution(request)
      return toRenderStatusVO(
        resumed ?? { ...execution, state: status.state },
        false,
        capabilities,
        true
      )
    }
    if (!capabilities.resume) {
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '当前构建尚未启用检查点继续，原记录保持不变'
      })
    }
    const checkpoint = await this.context.deps.history.readCheckpoint(request)
    const checkpointView = {
      ...checkpoint.view,
      candidateSnapshotId: checkpoint.candidateSnapshotId
    }
    const paused = canResumePausedSceneGeneration(execution, checkpointView)
    const interrupted = canResumeInterruptedSceneGeneration(execution, checkpointView)
    if (!paused && !interrupted) {
      throw new AppException({ code: ErrorCodes.operationConflict, msg: '当前检查点不能恢复执行' })
    }
    const status = paused
      ? await this.generation.resumeAuthorizedPause(request)
      : await this.generation.resumeSceneGeneration(request)
    const resumed = await this.context.deps.executions.readExecution(request)
    return toRenderStatusVO(
      resumed ?? { ...execution, state: status.state },
      false,
      this.context.deps.workflow.capabilities(),
      true
    )
  }

  /**
   * 只有持久记录能证明是“启动后尚未产生检查点”的崩溃现场才从这里继续。
   * 已有检查点、待核对中断、活动代次和身份过期的请求都拒绝，不能借无检查点入口绕过原门。
   */
  async resumeUnfinishedSceneGeneration(
    request: SceneGenerationRecoveryScopeDTO
  ): Promise<SceneGenerationRenderStatusVO> {
    const execution = await this.context.coordinator.requireExecution(request)
    assertRecoveryIdentity(execution, request)
    if (this.context.coordinator.activeExecutions.has(operationKey(request))) {
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '该操作仍在运行，不能重复恢复'
      })
    }
    assertUnfinishedRecoverable(execution)
    const status = await this.generation.resumeSceneGeneration(request)
    const resumed = await this.context.deps.executions.readExecution(request)
    return toRenderStatusVO(
      resumed ?? { ...execution, state: status.state },
      false,
      this.context.deps.workflow.capabilities(),
      true
    )
  }

  /**
   * 已成功提交但清理未完成时只补清理，不重开生成也不再提交。
   * 没有待清理事实时返回当前成功状态，重复请求不产生新提交或新操作。
   */
  async retrySceneGenerationCleanup(
    request: SceneGenerationRecoveryScopeDTO
  ): Promise<SceneGenerationRenderStatusVO> {
    const execution = await this.context.coordinator.requireExecution(request)
    assertRecoveryIdentity(execution, request)
    if (this.context.coordinator.activeExecutions.has(operationKey(request))) {
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '该操作仍在运行，不能重试提交后清理'
      })
    }
    if (execution.state !== 'succeeded' || execution.result?.commitId === undefined) {
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '只有已提交结果可以重试清理'
      })
    }
    const capabilities = this.context.deps.workflow.capabilities()
    if (!hasCommittedCleanupPending(execution)) {
      return toRenderStatusVO(execution, false, capabilities, false)
    }
    const status = await this.generation.resumeSceneGeneration(request)
    const resumed = await this.context.deps.executions.readExecution(request)
    return toRenderStatusVO(resumed ?? { ...execution, state: status.state }, false, capabilities)
  }

  /**
   * 作者显式核对写入/提交待核对现场。线程串行、无活动代次，并先按五元身份
   * 重新读取持久记录；只读取真实提交事实、写入回执、不可变草稿与工作区归属。
   * 证据不足或只证明未写/未提交时保持原记录、候选、账本和工作区不变；
   * 只有已证明写入才进入既有候选校验/审阅门，只有已证明提交才按原提交结算。
   * 不新增提交、不调用模型，也不授予取消、删除、归档或普通续跑。
   */
  async verifyUnknownResult(
    request: SceneGenerationRecoveryScopeDTO
  ): Promise<SceneGenerationVerificationResultVO> {
    const initial = await this.context.coordinator.requireExecution(request)
    assertRecoveryIdentity(initial, request)
    return this.context.coordinator.serialize(threadKey(initial), async () => {
      const current = await this.context.coordinator.requireExecution(request)
      assertRecoveryIdentity(current, request)
      const scope = scopeOf(current)
      if (this.context.coordinator.activeExecutions.has(operationKey(request))) {
        throw new AppException({
          code: ErrorCodes.operationConflict,
          msg: '该操作仍在运行，不能重复核对结果'
        })
      }
      const capabilities = this.context.deps.workflow.capabilities()
      if (!canVerifyUnknownResult(current, false))
        return this.unchangedVerification(current, capabilities)
      const commit = await this.readCommitState(current)
      if (commit?.state === 'committed')
        return this.settleVerifiedCommit(current, commit.commitId, capabilities)
      if (commit === null || commit.state === 'unknown')
        return this.pendingVerification(
          current,
          capabilities,
          '提交结果仍不明；记录保持待核对，候选、工作区与账本未改动。'
        )
      if (current.interruptReason === 'commitUnknown') {
        return this.pendingVerification(
          current,
          capabilities,
          commit.state === 'rollbackRequired'
            ? '提交事实需要受控回退；本次核对未回退，记录保持待核对。'
            : '未发现已提交作品；记录保持待核对，候选、工作区与账本未改动。'
        )
      }
      if (commit.state !== 'notCommitted') {
        return this.pendingVerification(
          current,
          capabilities,
          '提交事实需要受控回退；本次核对未回退，记录保持待核对。'
        )
      }
      const proven = await this.proveVerifiedCandidate(current, scope)
      if (proven === undefined) {
        const latest = await this.context.deps.executions.readExecution(scope)
        return this.pendingVerification(
          latest ?? current,
          capabilities,
          '没有找到可证明的候选写入回执；记录保持待核对，候选、工作区与账本未改动。'
        )
      }
      // 旧记录可能还带取消受理、清理或待执行回复事实；核对只确认写入，
      // 不能借机清除这些限制，也不能替作者继续执行。
      if (
        proven.cancellationRequested === true ||
        proven.requiresCleanup === true ||
        proven.pendingReply !== undefined
      ) {
        return this.pendingVerification(
          proven,
          capabilities,
          '候选写入已确认，但记录仍有取消、清理或待执行回复事实；保持待核对，未继续生成。'
        )
      }
      return this.startVerifiedReview(proven, capabilities)
    })
  }

  private async unchangedVerification(
    execution: SceneGenerationExecution,
    capabilities: SceneGenerationWorkflowCapabilities
  ): Promise<SceneGenerationVerificationResultVO> {
    if (execution.state === 'waiting' && execution.candidateSnapshotId !== undefined) {
      return {
        outcome: 'candidateWritten',
        message: '候选写入已确认，请在现有审阅门处理。',
        status: toRenderStatusVO(execution, false, capabilities, false)
      }
    }
    if (execution.state === 'succeeded' && execution.result?.commitId !== undefined) {
      return {
        outcome: 'committed',
        message: '作品已提交，无需再次核对。',
        status: toRenderStatusVO(execution, false, capabilities, false)
      }
    }
    return {
      outcome: 'stillPending',
      message: '当前记录已不在待核对中断，本次核对未改动任何事实。',
      status: toRenderStatusVO(execution, false, capabilities, false)
    }
  }

  private async readCommitState(
    execution: SceneGenerationExecution
  ): Promise<SceneGenerationCommitState | null> {
    try {
      return await this.context.deps.versions.readOperationCommit(execution)
    } catch {
      return null
    }
  }

  private async settleVerifiedCommit(
    execution: SceneGenerationExecution,
    commitId: string,
    capabilities: SceneGenerationWorkflowCapabilities
  ): Promise<SceneGenerationVerificationResultVO> {
    const active: ActiveSceneGeneration = {
      execution,
      controller: new AbortController()
    }
    let settlementError: unknown
    try {
      await this.context.coordinator.completeExecution(active, commitId, async (patch) => {
        const updated = { ...execution, ...patch, sequence: execution.sequence + 1 }
        return this.context.deps.executions.writeExecution(updated)
      })
    } catch (error) {
      settlementError = error
    }
    const settled =
      (await this.context.deps.executions.readExecution(scopeOf(execution))) ?? active.execution
    if (settled.state === 'succeeded' && settled.result?.commitId !== undefined) {
      return {
        outcome: 'committed',
        message:
          settlementError === undefined
            ? '已确认作品提交，已按原提交结算。'
            : '已确认作品提交；清理尚未完成，可在工作台重试清理。',
        status: toRenderStatusVO(settled, false, capabilities, false)
      }
    }
    return {
      outcome: 'stillPending',
      message: '已确认作品提交，但原记录结算未完成；记录保持待核对，未再次提交。',
      status: toRenderStatusVO(settled, false, capabilities, false)
    }
  }

  private async proveVerifiedCandidate(
    execution: SceneGenerationExecution,
    scope: SceneGenerationScopeDTO
  ): Promise<SceneGenerationExecution | undefined> {
    let provenCandidate: string | undefined
    try {
      const recovery = await this.context.deps.writeRecovery.recoverCandidateWrite(
        execution,
        async (candidateSnapshotId) => {
          // 核对入口先暂存证明结果；只有整个恢复证明成功后才持久绑定，
          // 避免补写完成回执失败时把“仍待核对”的记录改成半写状态。
          provenCandidate = candidateSnapshotId
        }
      )
      if (recovery.outcome !== 'proven') return undefined
      const candidateSnapshotId = provenCandidate ?? recovery.candidateSnapshotId
      if (candidateSnapshotId !== execution.candidateSnapshotId) {
        await this.context.deps.executions.writeExecution({
          ...execution,
          candidateSnapshotId,
          sequence: execution.sequence + 1
        })
      }
    } catch {
      return undefined
    }
    return (await this.context.deps.executions.readExecution(scope)) ?? undefined
  }

  private async pendingVerification(
    execution: SceneGenerationExecution,
    capabilities: SceneGenerationWorkflowCapabilities,
    message: string
  ): Promise<SceneGenerationVerificationResultVO> {
    return {
      outcome: 'stillPending',
      message,
      status: toRenderStatusVO(execution, false, capabilities, false)
    }
  }

  private async startVerifiedReview(
    execution: SceneGenerationExecution,
    capabilities: SceneGenerationWorkflowCapabilities
  ): Promise<SceneGenerationVerificationResultVO> {
    if (execution.candidateSnapshotId === undefined)
      return this.pendingVerification(
        execution,
        capabilities,
        '候选写入证据不完整；记录保持待核对，候选与工作区未改动。'
      )
    // 检查点、分叉请求和旧交互都属于写入前边界；已证明的候选从既有重新判定入口
    // 进入审阅，不重放分叉复制、模型轮次或已消费的回复。
    const updated: SceneGenerationExecution = {
      ...execution,
      state: 'pending',
      step: undefined,
      interaction: undefined,
      pendingReply: undefined,
      live: undefined,
      failure: undefined,
      interruptReason: undefined,
      pauseRequested: false,
      checkpointId: undefined,
      forkRequest: undefined,
      sequence: execution.sequence + 1
    }
    const recorded = await this.context.deps.executions.writeExecution(updated)
    this.context.coordinator.startExecution(
      recorded,
      (runtime) => this.context.deps.workflow.resumeGeneration(runtime),
      true
    )
    return {
      outcome: 'candidateWritten',
      message: '已确认候选写入，正在按既有候选校验与审阅门复核。',
      status: toRenderStatusVO(recorded, false, capabilities, true)
    }
  }
}

/** 恢复行动只认持久记录上的线程与分支，不接受调用方越过操作归属。 */
function assertRecoveryIdentity(
  execution: SceneGenerationExecution,
  request: SceneGenerationRecoveryScopeDTO
): void {
  if (execution.threadId !== request.threadId || execution.branchId !== request.branchId)
    throw new AppException({ code: ErrorCodes.operationConflict, msg: '恢复身份已过期' })
}

/**
 * 无检查点入口只接受待运行/运行中且没有待核对、取消、回复或清理事实的记录。
 * 记录缺少继续生成所需的最低持久事实时按旧记录拒绝，不补造输入或基线。
 * 原因文案与状态投影共用同一判据，避免页面显示可恢复而入口拒绝。
 */
function assertUnfinishedRecoverable(execution: SceneGenerationExecution): void {
  const issue = unfinishedRecoveryIssue(execution)
  if (issue !== null)
    throw new AppException({ code: ErrorCodes.operationConflict, msg: issue })
}

/** 只把已有执行事实收敛成读取/写入所需的五元身份。 */
function scopeOf(execution: SceneGenerationExecution): SceneGenerationScopeDTO {
  return {
    projectId: execution.projectId,
    sceneId: execution.sceneId,
    operationId: execution.operationId
  }
}
