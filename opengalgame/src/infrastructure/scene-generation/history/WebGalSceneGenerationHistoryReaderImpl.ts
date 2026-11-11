import type { SceneGenerationHistoryReader } from '@application/scene-generation/ports/SceneGenerationHistoryReader'
import type {
  ListSceneGenerationHistoryDTO,
  ReadSceneGenerationCheckpointDTO
} from '@application/scene-generation/dto/SceneGenerationDTO'
import type { SceneGenerationCheckpoint } from '@application/scene-generation/models/SceneGenerationExecution'
import type { SceneGenerationHistoryVO } from '@application/scene-generation/vo/SceneGenerationVO'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { AiProjectFileSystemImpl } from '@infrastructure/ai/filesystem/AiProjectFileSystemImpl'
import { readWorkflowHistory } from '@infrastructure/workflow/history/workflowHistory'
import { langGraphThreadKey } from '@infrastructure/workflow/WorkflowIdentity'
import type { WebGalGenerationStateValue } from '../workflow/WebGalGenerationState'
import {
  createWebGalGenerationGraph,
  type WebGalGenerationGraphDependencies
} from '../workflow/createWebGalGenerationGraph'
import type { FileSceneGenerationExecutionRepositoryImpl } from '../execution/FileSceneGenerationExecutionRepositoryImpl'
import { readWebGalGenerationCheckpoint } from './WebGalGenerationCheckpoint'

export class WebGalSceneGenerationHistoryReaderImpl implements SceneGenerationHistoryReader {
  constructor(
    private readonly deps: WebGalGenerationGraphDependencies,
    private readonly files: AiProjectFileSystemImpl,
    private readonly executions: FileSceneGenerationExecutionRepositoryImpl
  ) {}

  /** 分页查询安全摘要，不执行或修复文件。 */
  async listHistory(request: ListSceneGenerationHistoryDTO): Promise<SceneGenerationHistoryVO> {
    if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100)
      throw new AppException({ code: ErrorCodes.invalidRequest, msg: '历史页大小必须为 1 到 100' })
    const operations = await this.executions.listThread(request)
    if (!operations.some((item) => item.branchId === request.branchId))
      throw new AppException({ code: ErrorCodes.forbidden, msg: '分支不属于当前线程' })
    const graph = createWebGalGenerationGraph(this.deps)
    const rawHistory = await readWorkflowHistory(graph, {
      ...request,
      operationId: 'history'
    })
    const history: typeof rawHistory = []
    for (const entry of rawHistory) {
      const snapshot = await graph.getState({
        configurable: {
          thread_id: langGraphThreadKey({ ...request, operationId: 'history' }),
          checkpoint_id: entry.checkpointId
        }
      })
      const execution = (snapshot.values as Partial<WebGalGenerationStateValue>).execution
      if (
        execution?.projectId === request.projectId &&
        execution.sceneId === request.sceneId &&
        execution.threadId === request.threadId &&
        execution.branchId === request.branchId
      )
        history.push(entry)
    }
    const start = request.cursor
      ? history.findIndex((item) => item.checkpointId === request.cursor) + 1
      : 0
    if (request.cursor && start === 0)
      throw new AppException({ code: ErrorCodes.invalidRequest, msg: '历史游标不存在' })
    const page = history.slice(start, start + request.limit)
    const checkpoints = await Promise.all(
      page.map((item) => this.readCheckpoint({ ...request, checkpointId: item.checkpointId }))
    )
    return {
      branches: [...new Set(operations.map((item) => item.branchId))].map((branchId) => ({
        branchId,
        sourceBranchId: operations.find((item) => item.branchId === branchId)?.fork?.branchId
      })),
      checkpoints: checkpoints.map((item) => item.view),
      nextCursor: start + page.length < history.length ? page.at(-1)?.checkpointId : undefined
    }
  }

  /** 应用恢复种子与安全展示分开，不暴露 LangGraph 原始状态。 */
  async readCheckpoint(
    request: ReadSceneGenerationCheckpointDTO
  ): Promise<SceneGenerationCheckpoint> {
    await this.executions.listThread(request)
    return readWebGalGenerationCheckpoint(this.deps, this.files, request)
  }
}
