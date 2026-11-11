import type {
  ListSceneGenerationHistoryDTO,
  ListSceneGenerationHistoryForSceneDTO,
  ReadSceneGenerationCheckpointDTO
} from '../../dto/SceneGenerationDTO'
import type {
  SceneGenerationCheckpointVO,
  SceneGenerationHistoryVO
} from '../../vo/SceneGenerationVO'
import type { SceneGenerationHistorySummaryVO } from '../../vo/SceneGenerationRenderVO'
import { toCheckpointVO } from '../../mapping/SceneGenerationViewMapper'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'

import type { SceneGenerationHistoryQueryService } from '../SceneGenerationHistoryQueryService'
import type { SceneGenerationHistoryReader } from '../../ports/SceneGenerationHistoryReader'
import type { SceneGenerationSceneHistoryReader } from '../../ports/SceneGenerationSceneHistoryReader'
import { toHistorySummary } from '../../mapping/SceneGenerationRenderProjection'
export class SceneGenerationHistoryQueryServiceImpl implements SceneGenerationHistoryQueryService {
  constructor(
    private readonly history: SceneGenerationHistoryReader,
    private readonly sceneHistory: SceneGenerationSceneHistoryReader
  ) {}
  /**
   * @throws {AppException} 历史读取失败或身份越界。
   */
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

  /**
   * 只将明确的安全详情字段交给调用方。
   * @throws {AppException} 检查点不存在或身份越界。
   */
  async readSceneGenerationCheckpoint(
    request: ReadSceneGenerationCheckpointDTO
  ): Promise<SceneGenerationCheckpointVO> {
    const checkpoint = await this.history.readCheckpoint(request)
    return toCheckpointVO(checkpoint.view)
  }

  /**
   * 只投影已保存操作的安全摘要，并按记录时间倒序分页。
   * 没有检查点、操作边界或已记录时间的操作不进入历史。同一时间以后追加的操作在前。
   * @throws {AppException} 页大小或游标无效，或历史读取失败。
   */
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

/** 最新记录在前；时间相同时，持久追加更后的操作在前。 */
function byNewestThenLaterAppend(
  left: { summary: SceneGenerationHistorySummaryVO; appendIndex: number },
  right: { summary: SceneGenerationHistorySummaryVO; appendIndex: number }
): number {
  if (left.summary.createdAt !== right.summary.createdAt) {
    return left.summary.createdAt < right.summary.createdAt ? 1 : -1
  }
  return right.appendIndex - left.appendIndex
}
