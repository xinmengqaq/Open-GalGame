import type { OpenSceneGenerationCandidatePreviewDTO } from '../../dto/SceneGenerationDTO'
import type { SceneGenerationExecution } from '../../models/SceneGenerationExecution'
import { candidatePreviewOpenContext } from '../../ports/SceneCandidatePreviewGateway'
import type { SceneGenerationCandidatePreviewVO } from '../../vo/SceneGenerationRenderVO'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { canPreviewPublishedCandidate } from '@domain/scene-generation/services/validateSceneGenerationReply'
import type { SceneGenerationDependencies } from './SceneGenerationCoordinator'
import type { SceneGenerationRenderDependencies } from './SceneGenerationRenderDependencies'
import type { SceneGenerationServiceContext } from './SceneGenerationServiceContext'

export class OpenSceneGenerationCandidatePreviewUseCase {
  constructor(
    private readonly context: SceneGenerationServiceContext,
    private readonly renderDeps: SceneGenerationRenderDependencies
  ) {}

  async openSceneGenerationCandidatePreview(
    request: OpenSceneGenerationCandidatePreviewDTO
  ): Promise<SceneGenerationCandidatePreviewVO> {
    const execution = await this.context.coordinator.requireExecution(request)
    if (execution.threadId !== request.threadId || execution.branchId !== request.branchId) {
      throw new AppException({ code: ErrorCodes.forbidden, msg: '预览不属于当前操作' })
    }
    const published = await publishedCandidates(this.context.deps, execution)
    if (!canPreviewPublishedCandidate(request, published)) {
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '候选修订未发布或不属于当前操作'
      })
    }
    if (!candidateAcceptedForPreview(execution, request.candidateSnapshotId)) {
      throw new AppException({
        code: ErrorCodes.operationConflict,
        msg: '候选尚未通过生成校验，不能进入预览'
      })
    }
    const opened = await this.renderDeps.preview.openPublishedCandidatePreview(
      request,
      candidatePreviewOpenContext(execution.source)
    )
    return opened.preview
  }
}

async function publishedCandidates(
  deps: SceneGenerationDependencies,
  execution: SceneGenerationExecution
): Promise<
  readonly {
    operationId: string
    threadId: string
    branchId: string
    checkpointId: string
    candidateSnapshotId: string
  }[]
> {
  const current =
    execution.candidateSnapshotId && execution.checkpointId
      ? [
          {
            operationId: execution.operationId,
            threadId: execution.threadId,
            branchId: execution.branchId,
            checkpointId: execution.checkpointId,
            candidateSnapshotId: execution.candidateSnapshotId
          }
        ]
      : []
  // 本操作已记录的旧修订与当前修订并列；只授权记录中的修订，不按 Git 对象枚举。
  const recorded = (execution.publishedCandidates ?? []).map((record) => ({
    operationId: execution.operationId,
    threadId: execution.threadId,
    branchId: execution.branchId,
    checkpointId: record.checkpointId,
    candidateSnapshotId: record.candidateSnapshotId
  }))
  const history = await deps.history.listHistory({
    projectId: execution.projectId,
    sceneId: execution.sceneId,
    threadId: execution.threadId,
    branchId: execution.branchId,
    limit: 100
  })
  const historical = await Promise.all(
    history.checkpoints.map((checkpoint) =>
      deps.history.readCheckpoint({
        projectId: execution.projectId,
        sceneId: execution.sceneId,
        threadId: execution.threadId,
        branchId: execution.branchId,
        checkpointId: checkpoint.checkpointId
      })
    )
  )
  return [
    ...current,
    ...recorded,
    ...historical.flatMap((checkpoint) =>
      checkpoint.candidateSnapshotId
        ? [
            {
              operationId: execution.operationId,
              threadId: execution.threadId,
              branchId: execution.branchId,
              checkpointId: checkpoint.view.checkpointId,
              candidateSnapshotId: checkpoint.candidateSnapshotId
            }
          ]
        : []
    )
  ]
}

/**
 * 请求修订必须属于本操作已登记的通过候选；当前候选没有登记时只认当前校验结论。
 * 旧记录没有该事实时不能当成已通过，也不能按任意 Git 对象放行。
 */
function candidateAcceptedForPreview(
  execution: SceneGenerationExecution,
  candidateSnapshotId: string
): boolean {
  const record = execution.publishedCandidates?.find(
    (item) => item.candidateSnapshotId === candidateSnapshotId
  )
  if (record) return record.artifactValidation.issues.length === 0
  return (
    execution.candidateSnapshotId === candidateSnapshotId &&
    execution.artifactValidation !== undefined &&
    execution.artifactValidation.issues.length === 0
  )
}
