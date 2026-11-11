import type { RetrySceneGenerationRepairDTO } from '../../dto/SceneGenerationDTO'
import type { SceneGenerationCheckpoint, SceneGenerationExecution } from '../../models/SceneGenerationExecution'
import type { SceneGenerationOperationVO } from '../../vo/SceneGenerationVO'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { canRetryFailedSceneGenerationRepair } from '@domain/scene-generation/services/validateSceneGenerationReply'
import { generationFingerprint, requireAcceptable } from './SceneGenerationApplicationRules'
import { operationKey } from '../../policies/SceneGenerationIdempotency'
import { buildSceneGenerationRepairContext } from '../../policies/SceneGenerationRepairContextPolicy'
import { toOperationVO } from '../../mapping/SceneGenerationViewMapper'
import { requireRepairInstruction } from './SceneGenerationRequestGuards'
import type { SceneGenerationServiceContext } from './SceneGenerationServiceContext'

export class RetryFailedRepairUseCase {
  constructor(private readonly context: SceneGenerationServiceContext) {}

  retryFailedRepair(
    request: RetrySceneGenerationRepairDTO & { operationId: string }
  ): Promise<SceneGenerationOperationVO> {
    const snapshot = structuredClone(request)
    requireRepairInstruction(snapshot.repair.instruction)
    return this.context.coordinator.serialize(operationKey(snapshot), async () => {
      const fingerprint = generationFingerprint(snapshot)
      const previous = await this.context.coordinator.replay(snapshot, fingerprint)
      if (previous) return toOperationVO(previous)
      const source = await this.context.coordinator.requireExecution({
        projectId: snapshot.projectId,
        sceneId: snapshot.sceneId,
        operationId: snapshot.repair.sourceOperationId
      })
      if (
        !canRetryFailedSceneGenerationRepair(source, {
          projectId: snapshot.projectId,
          sceneId: snapshot.sceneId,
          ...snapshot.repair
        })
      ) {
        throw new AppException({
          code: ErrorCodes.operationConflict,
          msg: '来源修复不能重跑，已保留原失败记录'
        })
      }
      let checkpoint: SceneGenerationCheckpoint | undefined, repairContextError: unknown
      try {
        checkpoint = await this.context.deps.history.readCheckpoint({
          projectId: source.projectId,
          sceneId: source.sceneId,
          threadId: source.threadId,
          branchId: source.branchId,
          checkpointId: source.checkpointId!
        })
      } catch (error) {
        repairContextError = error
      }
      // 上下文构造直接抛出安全业务文案（如来源上下文过大），不改写成通用失败。
      const repairContext = checkpoint
        ? buildSceneGenerationRepairContext(source, checkpoint, snapshot.repair.instruction)
        : undefined
      if (!repairContext)
        throw new AppException({
          code: ErrorCodes.operationConflict,
          msg: '来源修复上下文不完整，已保留原失败记录',
          cause: repairContextError
        })
      const threadId = this.context.deps.nextId()
      const branchId = this.context.deps.nextId()
      await this.context.coordinator.requireIdleThread({ ...snapshot, threadId })
      const located = await this.context.deps.input.locateScene(snapshot)
      const inputSnapshot = structuredClone(
        await this.context.deps.input.readInputs(located, {
          canvasId: snapshot.canvasId,
          confirmedControls: snapshot.confirmedControls
        })
      )
      const baseline = await this.context.deps.versions.readBaseline(located)
      const execution: SceneGenerationExecution = {
        projectId: snapshot.projectId,
        sceneId: snapshot.sceneId,
        operationId: snapshot.operationId,
        threadId,
        branchId,
        fingerprint,
        source: located,
        inputSnapshot,
        policy: snapshot.policy,
        reviewCandidate: true,
        baseline,
        state: 'pending',
        step: 'preparing',
        attempt: 0,
        sequence: 0,
        budget: { correctionsUsed: 0, modelCallsUsed: 0, toolCallsUsed: 0, activeElapsedMs: 0 },
        mode: 'repair',
        repairSource: {
          operationId: source.operationId,
          threadId: source.threadId,
          branchId: source.branchId,
          checkpointId: source.checkpointId!,
          candidateSnapshotId: source.candidateSnapshotId!
        },
        repairContext,
        replies: []
      }
      requireAcceptable(execution, { baselineState: 'unchanged', lockState: baseline.lockState })
      const recorded = await this.context.deps.executions.createExecution(execution)
      this.context.coordinator.startExecution(
        recorded,
        (runtime) => this.context.deps.workflow.executeGeneration(runtime),
        false
      )
      return toOperationVO(recorded)
    })
  }
}
