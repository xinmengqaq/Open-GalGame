import type {
  ListSceneGenerationHistoryDTO,
  ListSceneGenerationHistoryForSceneDTO,
  ReadSceneGenerationCheckpointDTO
} from '../../dto/SceneGenerationDTO'
import type {
  SceneGenerationCheckpointVO,
  SceneGenerationHistoryVO
} from '../../vo/SceneGenerationVO'
import type { SceneGenerationHistoryDetailVO, SceneGenerationHistorySummaryVO } from '../../vo/SceneGenerationRenderVO'
import { toCheckpointVO } from '../../mapping/SceneGenerationViewMapper'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'

import type { SceneGenerationHistoryQueryService } from '../SceneGenerationHistoryQueryService'
import type { SceneGenerationHistoryReader } from '../../ports/SceneGenerationHistoryReader'
import type { SceneGenerationSceneHistoryReader } from '../../ports/SceneGenerationSceneHistoryReader'
import { toHistorySummary } from '../../mapping/SceneGenerationRenderProjection'
export class QuerySceneGenerationHistory implements SceneGenerationHistoryQueryService {
  constructor(
    private readonly history: SceneGenerationHistoryReader,
    private readonly sceneHistory: SceneGenerationSceneHistoryReader
  ) {}
  async listSceneGenerationHistory(
    request: ListSceneGenerationHistoryDTO
  ): Promise<SceneGenerationHistoryVO> {
    const history = await this.history.listHistory(request)
    return {
      branches: history.branches.map((branch) => ({
        branchId: branch.branchId,
        sourceBranchId: branch.sourceBranchId,
        checkpointId: branch.checkpointId
      })),
      checkpoints: history.checkpoints.map(toCheckpointVO),
      nextCursor: history.nextCursor
    }
  }

  async readSceneGenerationCheckpoint(
    request: ReadSceneGenerationCheckpointDTO
  ): Promise<SceneGenerationCheckpointVO> {
    const checkpoint = await this.history.readCheckpoint(request)
    return toCheckpointVO(checkpoint.view)
  }

  /**
   * 分叉资格只取检查点读取结果；列表中的边界、阶段和候选存在都不参与判断。
   * 只投影安全摘要、布尔资格和用户可读原因，不返回差异、预览或内部恢复种子。
   * @throws {AppException} 检查点不存在、身份越界或缺少记录时间。
   */
  async readSceneGenerationHistoryDetail(
    request: ReadSceneGenerationCheckpointDTO
  ): Promise<SceneGenerationHistoryDetailVO> {
    const checkpoint = await this.history.readCheckpoint(request)
    const createdAt =
      checkpoint.execution.updatedAt ??
      checkpoint.execution.timeline?.at(-1)?.createdAt ??
      checkpoint.execution.createdAt
    if (!createdAt) {
      throw new AppException({
        code: ErrorCodes.invalidRequest,
        msg: '这条历史没有可展示的记录时间'
      })
    }
    const summary = toHistorySummary(checkpoint.execution, createdAt, request.checkpointId)
    if (!summary) {
      throw new AppException({
        code: ErrorCodes.invalidRequest,
        msg: '这条历史没有可展示的操作边界'
      })
    }
    const canFork = checkpoint.view.canFork === true
    return {
      ...summary,
      canFork,
      ...(canFork ? {} : { forkReason: checkpoint.view.reason ?? '这条记录不能分叉' })
    }
  }

  async listSceneGenerationHistoryForScene(
    request: ListSceneGenerationHistoryForSceneDTO
  ): Promise<readonly SceneGenerationHistorySummaryVO[]> {
    if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100) {
      throw new AppException({ code: ErrorCodes.invalidRequest, msg: '历史页大小必须为 1 到 100' })
    }
    const executions = await this.sceneHistory.listSceneExecutions(request)
    const projected = executions.flatMap((execution, appendIndex) => {
      const createdAt = execution.updatedAt ?? execution.timeline?.at(-1)?.createdAt
      const summary = createdAt ? toHistorySummary(execution, createdAt) : undefined
      return summary ? [{ summary, appendIndex }] : []
    })
    projected.sort(byNewestThenLaterAppend)
    const summaries = projected.map((item) => item.summary)
    const start = request.cursor
      ? summaries.findIndex((item) => item.checkpointId === request.cursor) + 1
      : 0
    if (request.cursor && start === 0) {
      throw new AppException({ code: ErrorCodes.invalidRequest, msg: '历史游标不存在' })
    }
    return summaries.slice(start, start + request.limit)
  }
}

function byNewestThenLaterAppend(
  left: { summary: SceneGenerationHistorySummaryVO; appendIndex: number },
  right: { summary: SceneGenerationHistorySummaryVO; appendIndex: number }
): number {
  if (left.summary.createdAt !== right.summary.createdAt) {
    return left.summary.createdAt < right.summary.createdAt ? 1 : -1
  }
  return right.appendIndex - left.appendIndex
}
