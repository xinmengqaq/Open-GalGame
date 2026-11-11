import type {
  CloseSceneGenerationCandidatePreviewDTO,
  ListSceneGenerationHistoryForSceneDTO,
  OpenSceneGenerationCandidatePreviewDTO,
  ReadSceneGenerationCheckpointDTO,
  ReplySceneGenerationInteractionDTO,
  ResumeSceneGenerationDTO,
  RetrySceneGenerationRepairDTO,
  SceneGenerationScopeDTO,
  StartSceneGenerationDTO
} from '@application/scene-generation/dto/SceneGenerationDTO'
import type {
  SceneGenerationCandidatePreviewVO,
  SceneGenerationHistorySummaryVO,
  SceneGenerationRenderProgressEventVO,
  SceneGenerationRenderStatusVO
} from '@application/scene-generation/vo/SceneGenerationRenderVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'

export interface SceneGenerationProgressScope {
  projectId: string
  sceneId: string
  operationId: string
  threadId: string
  branchId: string
}

/** 固定生成客户端。进度只刷新界面，成功以状态查询为准。 */
export interface SceneGenerationClient {
  start(request: StartSceneGenerationDTO): Promise<AjaxResult<SceneGenerationRenderStatusVO>>
  /**
   * 从已失败的修复阶段重跑。请求原样带来源操作、线程、分支、检查点、候选和确认正文；
   * 客户端不重建身份，也不补路径或检查点内部。
   */
  retryRepair(
    request: RetrySceneGenerationRepairDTO
  ): Promise<AjaxResult<SceneGenerationRenderStatusVO>>
  status(request: SceneGenerationScopeDTO): Promise<AjaxResult<SceneGenerationRenderStatusVO>>
  /**
   * 读取当前场景最近一次生成的安全状态，用于刷新或历史为空时恢复运行中、等待模型。
   * 最近一次操作可能还没有检查点；没有执行记录时 `data` 为 null。
   */
  latest(request: {
    projectId: string
    sceneId: string
  }): Promise<AjaxResult<SceneGenerationRenderStatusVO | null>>
  reply(
    request: ReplySceneGenerationInteractionDTO
  ): Promise<AjaxResult<SceneGenerationRenderStatusVO>>
  pause(request: SceneGenerationScopeDTO): Promise<AjaxResult<SceneGenerationRenderStatusVO>>
  resume(request: ResumeSceneGenerationDTO): Promise<AjaxResult<SceneGenerationRenderStatusVO>>
  cancel(request: SceneGenerationScopeDTO): Promise<AjaxResult<SceneGenerationRenderStatusVO>>
  listHistory(
    request: ListSceneGenerationHistoryForSceneDTO
  ): Promise<AjaxResult<readonly SceneGenerationHistorySummaryVO[]>>
  readCheckpoint(
    request: ReadSceneGenerationCheckpointDTO
  ): Promise<AjaxResult<SceneGenerationHistorySummaryVO>>
  openPreview(
    request: OpenSceneGenerationCandidatePreviewDTO
  ): Promise<AjaxResult<SceneGenerationCandidatePreviewVO>>
  closePreview(request: CloseSceneGenerationCandidatePreviewDTO): Promise<AjaxResult<null>>
  /**
   * 订阅进度事件。先注册渲染监听再向主进程发送订阅请求；订阅失败通过 `onError`
   * 回传安全文案，调用方需自行用状态查询兜底。返回同步退订函数。
   */
  subscribeProgress(
    scope: SceneGenerationProgressScope,
    listener: (event: SceneGenerationRenderProgressEventVO) => void,
    onError?: (message: string) => void
  ): () => void
  /** 断线后重新读取状态。进度事件不能代替这次查询。 */
  reconnect(request: SceneGenerationScopeDTO): Promise<AjaxResult<SceneGenerationRenderStatusVO>>
}
