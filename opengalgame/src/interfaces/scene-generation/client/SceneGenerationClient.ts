import type {
  CloseSceneGenerationCandidatePreviewDTO,
  ForkSceneGenerationFromHistoryDTO,
  ListSceneGenerationHistoryForSceneDTO,
  OpenSceneGenerationCandidatePreviewDTO,
  ReadSceneGenerationCheckpointDTO,
  ReplySceneGenerationInteractionDTO,
  ResumeSceneGenerationDTO,
  RetrySceneGenerationRepairDTO,
  SceneGenerationRecoveryScopeDTO,
  SceneGenerationScopeDTO,
  StartSceneGenerationDTO
} from '@application/scene-generation/dto/SceneGenerationDTO'
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

export interface SceneGenerationProgressScope {
  projectId: string
  sceneId: string
  operationId: string
  threadId: string
  branchId: string
}

export interface SceneGenerationClient {
  start(request: StartSceneGenerationDTO): Promise<AjaxResult<SceneGenerationRenderStatusVO>>
  retryRepair(
    request: RetrySceneGenerationRepairDTO
  ): Promise<AjaxResult<SceneGenerationRenderStatusVO>>
  /**
   * 读取指定操作的安全状态。失败信封只在仓储确认操作不存在时带
   * `FailureReasons.sceneGenerationOperationMissing`；检查点读取失败不带。
   */
  status(request: SceneGenerationScopeDTO): Promise<AjaxResult<SceneGenerationRenderStatusVO>>
  latest(request: {
    projectId: string
    sceneId: string
  }): Promise<AjaxResult<SceneGenerationRenderStatusVO | null>>
  reply(
    request: ReplySceneGenerationInteractionDTO
  ): Promise<AjaxResult<SceneGenerationRenderStatusVO>>
  pause(request: SceneGenerationScopeDTO): Promise<AjaxResult<SceneGenerationRenderStatusVO>>
  resume(request: ResumeSceneGenerationDTO): Promise<AjaxResult<SceneGenerationRenderStatusVO>>
  /**
   * 继续尚未产生检查点的崩溃现场。只提交操作、线程和分支身份；
   * 已有检查点、待核对或仍有活动代次的操作由主进程拒绝。
   */
  resumeUnfinished(
    request: SceneGenerationRecoveryScopeDTO
  ): Promise<AjaxResult<SceneGenerationRenderStatusVO>>
  /**
   * 已提交但清理未完成时只重试清理；不重开生成、不再次提交。
   */
  retryCleanup(
    request: SceneGenerationRecoveryScopeDTO
  ): Promise<AjaxResult<SceneGenerationRenderStatusVO>>
  cancel(request: SceneGenerationScopeDTO): Promise<AjaxResult<SceneGenerationRenderStatusVO>>
  /**
   * 按操作五元身份重新核对真实写入/提交事实，不新增提交或模型调用。
   * 证据仍不足时返回 `stillPending`，页面保持待核对现场。
   */
  verifyUnknownResult(
    request: SceneGenerationRecoveryScopeDTO
  ): Promise<AjaxResult<SceneGenerationVerificationResultVO>>
  listHistory(
    request: ListSceneGenerationHistoryForSceneDTO
  ): Promise<AjaxResult<SceneGenerationHistoryPageVO>>
  readCheckpoint(
    request: ReadSceneGenerationCheckpointDTO
  ): Promise<AjaxResult<SceneGenerationHistoryDetailVO>>
  /**
   * 从 AI 历史创建新分支。只提交来源分支、检查点和已批准策略；
   * 来源资格与新操作身份由主进程重新证明和生成。
   */
  fork(
    request: ForkSceneGenerationFromHistoryDTO
  ): Promise<AjaxResult<SceneGenerationForkVO>>
  openPreview(
    request: OpenSceneGenerationCandidatePreviewDTO
  ): Promise<AjaxResult<SceneGenerationCandidatePreviewVO>>
  closePreview(request: CloseSceneGenerationCandidatePreviewDTO): Promise<AjaxResult<null>>
  subscribeProgress(
    scope: SceneGenerationProgressScope,
    listener: (event: SceneGenerationRenderProgressEventVO) => void,
    onError?: (message: string) => void
  ): () => void
  reconnect(request: SceneGenerationScopeDTO): Promise<AjaxResult<SceneGenerationRenderStatusVO>>
}
