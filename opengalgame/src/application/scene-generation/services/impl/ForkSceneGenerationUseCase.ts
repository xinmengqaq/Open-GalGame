import type { ForkSceneGenerationDTO } from '../../dto/SceneGenerationDTO'
import type { SceneGenerationExecution } from '../../models/SceneGenerationExecution'
import type { SceneGenerationOperationVO } from '../../vo/SceneGenerationVO'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { generationFingerprint, requireAcceptable } from './SceneGenerationApplicationRules'
import { threadKey } from '../../policies/SceneGenerationIdempotency'
import { toOperationVO } from '../../mapping/SceneGenerationViewMapper'
import type { SceneGenerationServiceContext } from './SceneGenerationServiceContext'

export class ForkSceneGenerationUseCase {
  constructor(private readonly context: SceneGenerationServiceContext) {}

  /**
   * 从历史创建新分支与独立候选，原分支和正式工程不被回退。
   * @throws {AppException} 检查点不可继续、身份冲突或输入无效。
   */
  forkSceneGeneration(request: ForkSceneGenerationDTO): Promise<SceneGenerationOperationVO> {
    const snapshot = structuredClone(request)
    return this.context.coordinator.serialize(threadKey(snapshot), async () => {
      const fingerprint = generationFingerprint(snapshot)
      const previous = await this.context.coordinator.replay(snapshot, fingerprint)
      if (previous) return toOperationVO(previous)
      await this.context.coordinator.requireIdleThread(snapshot)
      const checkpoint = await this.context.deps.history.readCheckpoint(snapshot)
      if (!checkpoint.view.canContinue)
        throw new AppException({
          code: ErrorCodes.operationConflict,
          msg: checkpoint.view.reason ?? '该历史检查点不能继续执行'
        })
      const source = await this.context.deps.input.locateScene(snapshot)
      const inputSnapshot = snapshot.inputChanges
        ? await this.context.deps.input.readInputs(source, snapshot.inputChanges)
        : checkpoint.execution.inputSnapshot
      const baseline = await this.context.deps.versions.readBaseline(source)
      const execution: SceneGenerationExecution = {
        projectId: snapshot.projectId,
        sceneId: snapshot.sceneId,
        operationId: snapshot.operationId,
        threadId: snapshot.threadId,
        branchId: this.context.deps.nextId(),
        fingerprint,
        source,
        inputSnapshot: structuredClone(inputSnapshot),
        policy: snapshot.policy,
        reviewCandidate: snapshot.reviewCandidate ?? false,
        baseline,
        state: 'pending',
        step: 'preparing',
        attempt: 0,
        sequence: 0,
        budget: { correctionsUsed: 0, modelCallsUsed: 0, toolCallsUsed: 0, activeElapsedMs: 0 },
        replies: [],
        fork: {
          projectId: snapshot.projectId,
          sceneId: snapshot.sceneId,
          threadId: snapshot.threadId,
          branchId: snapshot.branchId,
          checkpointId: snapshot.checkpointId
        },
        forkRequest: snapshot,
        checkpointId: snapshot.checkpointId,
        candidateSnapshotId: checkpoint.candidateSnapshotId
      }
      requireAcceptable(execution, { baselineState: 'unchanged', lockState: baseline.lockState })
      const recorded = await this.context.deps.executions.createExecution(execution)
      this.context.coordinator.startExecution(
        recorded,
        (runtime) => this.context.deps.workflow.forkGeneration(runtime, snapshot),
        true
      )
      return toOperationVO(recorded)
    })
  }
}
