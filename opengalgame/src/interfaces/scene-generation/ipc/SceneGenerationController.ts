import type { SceneGenerationCandidatePreviewService } from '@application/scene-generation/services/SceneGenerationCandidatePreviewService'
import type { SceneGenerationApplicationService } from '@application/scene-generation/services/SceneGenerationApplicationService'
import type { SceneGenerationControlService } from '@application/scene-generation/services/SceneGenerationControlService'
import type { SceneGenerationHistoryQueryService } from '@application/scene-generation/services/SceneGenerationHistoryQueryService'
import type { SceneGenerationLaunchService } from '@application/scene-generation/services/SceneGenerationLaunchService'
import type { SceneGenerationRenderQueryService } from '@application/scene-generation/services/SceneGenerationRenderQueryService'
import type {
  SceneGenerationCandidatePreviewVO,
  SceneGenerationForkVO,
  SceneGenerationHistoryDetailVO,
  SceneGenerationHistoryPageVO,
  SceneGenerationRenderProgressEventVO,
  SceneGenerationRenderStatusVO,
  SceneGenerationVerificationResultVO
} from '@application/scene-generation/vo/SceneGenerationRenderVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import { IpcExceptionHandler } from '../../ipc/errors/IpcExceptionHandler'
import { createRequestHandler, type IpcRequestHandler } from '../../ipc/requestHandler'
import type { IpcRequestAccess } from '../../ipc/RequestSchema'
import {
  closeSceneGenerationPreviewSchema,
  forkSceneGenerationSchema,
  latestSceneGenerationSchema,
  listSceneGenerationHistorySchema,
  openSceneGenerationPreviewSchema,
  readSceneGenerationCheckpointSchema,
  replySceneGenerationSchema,
  resumeSceneGenerationSchema,
  retrySceneGenerationRepairSchema,
  sceneGenerationProgressSchema,
  sceneGenerationScopeSchema,
  startSceneGenerationSchema,
  verifySceneGenerationUnknownSchema
} from './SceneGenerationRequestSchema'

export interface SceneGenerationApplicationGateway {
  readonly launch: SceneGenerationLaunchService
  readonly renderQuery: SceneGenerationRenderQueryService
  readonly control: SceneGenerationControlService
  readonly history: SceneGenerationHistoryQueryService
  readonly preview: SceneGenerationCandidatePreviewService
  readonly generation: SceneGenerationApplicationService
}

export class SceneGenerationController {
  private readonly handle: IpcRequestHandler

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

  /**
   * 既有检查点恢复保持原请求与强校验；`recovery` 分支只走操作身份，
   * 用于无检查点崩溃现场、提交后清理重试或待核对结果核对。
   */
  async resume(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<
    AjaxResult<SceneGenerationRenderStatusVO | SceneGenerationVerificationResultVO>
  > {
    // 冻结的 preload 清单不允许新增通道，核对复用同一恢复通道和请求身份。
    if (
      typeof input === 'object' &&
      input !== null &&
      'recovery' in input &&
      input.recovery === 'verify'
    ) {
      const { recovery: _recovery, ...scope } = input
      return this.verifyUnknownResult(scope, access)
    }
    return this.handle(
      resumeSceneGenerationSchema,
      input,
      access,
      (status: SceneGenerationRenderStatusVO) =>
        status.state === 'succeeded'
          ? '提交后清理已重试'
          : status.checkpointId === undefined
            ? '已继续未完成的生成'
            : '已从安全检查点恢复',
      (request) => {
        if (!('recovery' in request))
          return this.services.control.resumeSceneGeneration(request)
        const { recovery, ...scope } = request
        return recovery === 'unfinished'
          ? this.services.control.resumeUnfinishedSceneGeneration(scope)
          : this.services.control.retrySceneGenerationCleanup(scope)
      }
    )
  }

  cancel(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<SceneGenerationRenderStatusVO>> {
    return this.handle(
      sceneGenerationScopeSchema,
      input,
      access,
      (status: SceneGenerationRenderStatusVO) =>
        status.state === 'cancelled' ? '场景生成已取消' : '取消已受理，正在结束本次生成',
      (request) => this.services.control.cancelSceneGeneration(request)
    )
  }

  /**
   * 待核对结果只按操作身份重新读取真实写入/提交事实。证据仍不足时保持待核对；
   * 成功也只返回核对事实和当前安全状态，由页面如实展示，不在这里新增提交。
   */
  verifyUnknownResult(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<SceneGenerationVerificationResultVO>> {
    return this.handle(
      verifySceneGenerationUnknownSchema,
      input,
      access,
      '核对完成',
      (request) => this.services.control.verifyUnknownResult(request)
    )
  }

  async listHistory(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<SceneGenerationHistoryPageVO>> {
    return this.handle(
      listSceneGenerationHistorySchema,
      input,
      access,
      '场景生成历史已读取',
      async (request) => {
        // 两类分页各有独立游标，同一请求只推进其中一种；schema 已拒绝混用。
        if (request.unfinishedCursor !== undefined) {
          const page = await this.services.renderQuery.listUnfinishedSceneGenerations({
            projectId: request.projectId,
            sceneId: request.sceneId,
            cursor: request.unfinishedCursor,
            limit: request.unfinishedLimit ?? 100
          })
          return withUnfinishedCursor({ items: [], unfinished: page.items }, page.nextCursor)
        }
        const items = await this.services.history.listSceneGenerationHistoryForScene(request)
        if (request.cursor !== undefined) return { items, unfinished: [] }
        const page = await this.services.renderQuery.listUnfinishedSceneGenerations({
          projectId: request.projectId,
          sceneId: request.sceneId,
          limit: request.unfinishedLimit ?? 100
        })
        return withUnfinishedCursor({ items, unfinished: page.items }, page.nextCursor)
      }
    )
  }

  readCheckpoint(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<SceneGenerationHistoryDetailVO>> {
    return this.handle(
      readSceneGenerationCheckpointSchema,
      input,
      access,
      '检查点已读取',
      (request) => this.services.history.readSceneGenerationHistoryDetail(request)
    )
  }

  /**
   * 从 AI 历史创建分支。只把严格校验后的来源身份和策略交给启动服务；
   * 新操作身份、来源资格与失败原因均由应用层生成或重新证明。
   */
  fork(
    input: unknown,
    access: IpcRequestAccess
  ): Promise<AjaxResult<SceneGenerationForkVO>> {
    return this.handle(
      forkSceneGenerationSchema,
      input,
      access,
      '已从历史创建新分支',
      (request) => this.services.launch.forkSceneGeneration(request)
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

/** 只在确有更早条目时携带游标，避免页面多请求一轮空页。 */
function withUnfinishedCursor(
  page: Pick<SceneGenerationHistoryPageVO, 'items' | 'unfinished'>,
  nextCursor: string | undefined
): SceneGenerationHistoryPageVO {
  return nextCursor === undefined ? page : { ...page, unfinishedNextCursor: nextCursor }
}
