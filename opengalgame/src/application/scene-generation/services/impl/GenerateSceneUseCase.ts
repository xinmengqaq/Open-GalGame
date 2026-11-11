import type { GenerateSceneDTO } from '../../dto/SceneGenerationDTO'
import type { SceneGenerationExecution } from '../../models/SceneGenerationExecution'
import type { SceneGenerationOperationVO } from '../../vo/SceneGenerationVO'
import { AppException } from '@common/errors/AppException'
import { SceneCanvasErrorCodes } from '@domain/scene-canvas/errors/SceneCanvasErrorCodes'
import { generationFingerprint, requireAcceptable } from './SceneGenerationApplicationRules'
import { operationKey, threadKey } from '../../policies/SceneGenerationIdempotency'
import { toOperationVO } from '../../mapping/SceneGenerationViewMapper'
import type { SceneGenerationServiceContext } from './SceneGenerationServiceContext'

export class GenerateSceneUseCase {
  constructor(private readonly context: SceneGenerationServiceContext) {}

  /**
   * @throws {AppException} 操作身份冲突、输入无效或基础能力调用失败。
   */
  generateScene(request: GenerateSceneDTO): Promise<SceneGenerationOperationVO> {
    const snapshot = structuredClone(request)
    const key = snapshot.branch
      ? threadKey({ ...snapshot, threadId: snapshot.branch.threadId })
      : operationKey(snapshot)
    return this.context.coordinator.serialize(key, async () => {
      const fingerprint = generationFingerprint(snapshot)
      const previous = await this.context.coordinator.replay(snapshot, fingerprint)
      if (previous) return toOperationVO(previous)
      const threadId = snapshot.branch?.threadId ?? this.context.deps.nextId()
      await this.context.coordinator.requireIdleThread({ ...snapshot, threadId })
      const source = await this.context.deps.input.locateScene(snapshot)
      const inputSnapshot = structuredClone(
        await this.context.deps.input.readInputs(source, snapshot.inputs)
      )
      if (
        snapshot.expectedArrangementVersion !== undefined &&
        inputSnapshot.arrangementVersion !== snapshot.expectedArrangementVersion
      ) {
        throw new AppException({
          code: SceneCanvasErrorCodes.commitUnknown,
          msg: '保存后的编排版本不一致，不能生成'
        })
      }
      const baseline = await this.context.deps.versions.readBaseline(source)
      const execution: SceneGenerationExecution = {
        projectId: snapshot.projectId,
        sceneId: snapshot.sceneId,
        operationId: snapshot.operationId,
        threadId,
        branchId: snapshot.branch?.branchId ?? this.context.deps.nextId(),
        fingerprint,
        source,
        inputSnapshot,
        policy: snapshot.policy,
        reviewCandidate: snapshot.reviewCandidate ?? false,
        baseline,
        state: 'pending',
        step: 'preparing',
        attempt: 0,
        sequence: 0,
        budget: { correctionsUsed: 0, modelCallsUsed: 0, toolCallsUsed: 0, activeElapsedMs: 0 },
        mode: 'generate',
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
