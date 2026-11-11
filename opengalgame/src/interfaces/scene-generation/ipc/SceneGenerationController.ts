import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { SceneGenerationCandidatePreviewService } from '@application/scene-generation/services/SceneGenerationCandidatePreviewService'
import type { SceneGenerationApplicationService } from '@application/scene-generation/services/SceneGenerationApplicationService'
import type { SceneGenerationControlService } from '@application/scene-generation/services/SceneGenerationControlService'
import type { SceneGenerationHistoryQueryService } from '@application/scene-generation/services/SceneGenerationHistoryQueryService'
import type { SceneGenerationLaunchService } from '@application/scene-generation/services/SceneGenerationLaunchService'
import type { SceneGenerationRenderQueryService } from '@application/scene-generation/services/SceneGenerationRenderQueryService'
import type {
  SceneGenerationCandidatePreviewVO,
  SceneGenerationHistorySummaryVO,
  SceneGenerationRenderProgressEventVO,
  SceneGenerationRenderStatusVO
} from '@application/scene-generation/vo/SceneGenerationRenderVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import { IpcExceptionHandler } from '../../ipc/errors/IpcExceptionHandler'
import { createRequestHandler, type IpcRequestHandler } from '../../ipc/requestHandler'
import type { IpcRequestAccess } from '../../ipc/RequestSchema'
import {
  closeSceneGenerationPreviewSchema,
  latestSceneGenerationSchema,
  listSceneGenerationHistorySchema,
  openSceneGenerationPreviewSchema,
  readSceneGenerationCheckpointSchema,
  replySceneGenerationSchema,
  resumeSceneGenerationSchema,
  retrySceneGenerationRepairSchema,
  sceneGenerationProgressSchema,
  sceneGenerationScopeSchema,
  startSceneGenerationSchema
} from './SceneGenerationRequestSchema'

export interface SceneGenerationApplicationGateway {
  readonly launch: SceneGenerationLaunchService
  readonly renderQuery: SceneGenerationRenderQueryService
  readonly control: SceneGenerationControlService
  readonly history: SceneGenerationHistoryQueryService
  readonly preview: SceneGenerationCandidatePreviewService
  readonly generation: SceneGenerationApplicationService
}

/** 只调用四个渲染服务和场景历史，不读取文件、路径或内部检查点。 */
export class SceneGenerationController {
  private readonly handle: IpcRequestHandler

  /**
   * @param services - 已装配的生成应用服务。
   * @param exceptions - 统一失败出口。
   */
  constructor(
    private readonly services: SceneGenerationApplicationGateway,
    exceptions: IpcExceptionHandler
  ) {
    this.handle = createRequestHandler(exceptions)
  }

  start(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<SceneGenerationRenderStatusVO>> {
    return this.handle(startSceneGenerationSchema, input, access, '场景生成已启动', (request) =>
      this.services.launch.startSceneGeneration(request)
    )
  }

  status(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<SceneGenerationRenderStatusVO>> {
    return this.handle(sceneGenerationScopeSchema, input, access, '生成状态已读取', (request) =>
      this.services.renderQuery.getSceneGenerationRenderStatus(request)
    )
  }

  /** 最近一次操作可能仍在运行且没有检查点，读取安全状态供刷新后恢复。 */
  latest(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<SceneGenerationRenderStatusVO | null>> {
    return this.handle(latestSceneGenerationSchema, input, access, '生成状态已读取', (request) =>
      this.services.renderQuery.findLatestSceneGeneration(request)
    )
  }

  subscribe(input: unknown, access: IpcRequestAccess): Promise<AjaxResult<null>> {
    return this.handle(sceneGenerationProgressSchema, input, access, '生成进度已订阅', () => null)
  }

  /** 订阅应用层进度。调用方负责在窗口销毁或重新订阅时退订。 */
  watchProgress(
    request: {
      projectId: string
      sceneId: string
      operationId: string
      threadId: string
      branchId: string
    },
    publish: (event: SceneGenerationRenderProgressEventVO) => void
  ): () => void {
    return this.services.renderQuery.subscribeSceneGenerationProgress(request, publish)
  }

  /** 只把严格校验后的来源身份和确认正文交给启动服务，响应仍是安全渲染状态。 */
  retryRepair(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<SceneGenerationRenderStatusVO>> {
    return this.handle(
      retrySceneGenerationRepairSchema,
      input,
      access,
      '修复重跑已启动',
      (request) => this.services.launch.retrySceneGenerationRepair(request)
    )
  }

  reply(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<SceneGenerationRenderStatusVO>> {
    return this.handle(replySceneGenerationSchema, input, access, '回复已接受', async (request) => {
      await this.services.generation.replySceneGenerationInteraction(request)
      return this.services.renderQuery.getSceneGenerationRenderStatus(request)
    })
  }

  pause(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<SceneGenerationRenderStatusVO>> {
    return this.handle(sceneGenerationScopeSchema, input, access, '已请求安全暂停', (request) =>
      this.services.control.pauseSceneGeneration(request)
    )
  }

  resume(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<SceneGenerationRenderStatusVO>> {
    return this.handle(
      resumeSceneGenerationSchema,
      input,
      access,
      '已从安全检查点恢复',
      (request) => this.services.control.resumeSceneGeneration(request)
    )
  }

  cancel(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<SceneGenerationRenderStatusVO>> {
    return this.handle(sceneGenerationScopeSchema, input, access, '场景生成已取消', (request) =>
      this.services.control.cancelSceneGeneration(request)
    )
  }

  listHistory(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<readonly SceneGenerationHistorySummaryVO[]>> {
    return this.handle(
      listSceneGenerationHistorySchema,
      input,
      access,
      '场景生成历史已读取',
      (request) => this.services.history.listSceneGenerationHistoryForScene(request)
    )
  }

  readCheckpoint(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<SceneGenerationHistorySummaryVO>> {
    return this.handle(
      readSceneGenerationCheckpointSchema,
      input,
      access,
      '检查点已读取',
      async (request) => {
        const history = await this.services.history.listSceneGenerationHistoryForScene({
          projectId: request.projectId,
          sceneId: request.sceneId,
          limit: 100
        })
        const summary = history.find(
          (item) =>
            item.threadId === request.threadId &&
            item.branchId === request.branchId &&
            item.checkpointId === request.checkpointId
        )
        if (!summary) {
          throw new AppException({ code: ErrorCodes.invalidRequest, msg: '该检查点不存在' })
        }
        return summary
      }
    )
  }

  openPreview(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<SceneGenerationCandidatePreviewVO>> {
    return this.handle(
      openSceneGenerationPreviewSchema,
      input,
      access,
      '候选预览已打开',
      (request) => this.services.preview.openSceneGenerationCandidatePreview(request)
    )
  }

  closePreview(input: unknown, access: IpcRequestAccess): Promise<AjaxResult<null>> {
    return this.handle(
      closeSceneGenerationPreviewSchema,
      input,
      access,
      '候选预览已关闭',
      async (request) => {
        await this.services.preview.closeSceneGenerationCandidatePreview(request)
        return null
      }
    )
  }
}
