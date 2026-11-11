import type { StartSceneGenerationDTO } from '../../dto/SceneGenerationDTO'
import type { SceneGenerationRenderStatusVO } from '../../vo/SceneGenerationRenderVO'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { SceneCanvasErrorCodes } from '@domain/scene-canvas/errors/SceneCanvasErrorCodes'
import { SceneGenerationErrorCodes } from '@domain/scene-generation/errors/SceneGenerationErrorCodes'
import { toRenderStatusVO } from '../../mapping/SceneGenerationRenderProjection'
import { requireNoActiveGeneration } from '../../policies/SceneGenerationStartConflict'
import type { SceneGenerationApplicationService } from '../SceneGenerationApplicationService'
import { saveLaunchArrangement } from './SceneGenerationLaunchArrangement'
import { requireLaunchIdentity } from './SceneGenerationRequestGuards'
import type { SceneGenerationRenderDependencies } from './SceneGenerationRenderDependencies'
import type { SceneGenerationServiceContext } from './SceneGenerationServiceContext'

export class StartSceneGenerationUseCase {
  constructor(
    private readonly context: SceneGenerationServiceContext,
    private readonly renderDeps: SceneGenerationRenderDependencies,
    private readonly generation: SceneGenerationApplicationService
  ) {}

  async startSceneGeneration(
    request: StartSceneGenerationDTO
  ): Promise<SceneGenerationRenderStatusVO> {
    const snapshot = structuredClone(request)
    requireLaunchIdentity(snapshot)
    // 仓储按场景返回全部记录，limit 只用于满足查询契约。
    const sceneExecutions = await this.context.deps.executions.listSceneExecutions({
      projectId: snapshot.projectId,
      sceneId: snapshot.sceneId,
      limit: 100
    })
    requireNoActiveGeneration(sceneExecutions)
    const saved = await saveLaunchArrangement(this.context.deps, this.renderDeps, snapshot)
    const source = await this.renderDeps.production.resolveRegisteredScene(snapshot)
    const baseline = await this.context.deps.versions.readBaseline(source)
    if (!baseline.commitId || baseline.lockState === 'unknown') {
      throw new AppException({
        code: SceneGenerationErrorCodes.gitQueryFailed,
        msg: '当前场景状态不明，不能覆盖'
      })
    }
    const inputSnapshot = structuredClone(
      await this.context.deps.input.readInputs(source, {
        canvasId: snapshot.canvasId,
        confirmedControls: snapshot.confirmedControls
      })
    )
    if (inputSnapshot.arrangementVersion !== saved.arrangementVersion) {
      throw new AppException({
        code: SceneCanvasErrorCodes.commitUnknown,
        msg: '保存后的编排版本不一致，不能生成'
      })
    }
    const operationId = this.context.deps.nextId()
    await this.generation.generateScene({
      projectId: snapshot.projectId,
      sceneId: snapshot.sceneId,
      operationId,
      inputs: { canvasId: snapshot.canvasId, confirmedControls: snapshot.confirmedControls },
      policy: snapshot.policy,
      reviewCandidate: true,
      expectedArrangementVersion: saved.arrangementVersion
    })
    const execution = await this.context.deps.executions.readExecution({ ...snapshot, operationId })
    if (!execution || execution.inputSnapshot.arrangementVersion !== saved.arrangementVersion) {
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '生成没有绑定已保存编排版本'
      })
    }
    return toRenderStatusVO(execution)
  }
}
