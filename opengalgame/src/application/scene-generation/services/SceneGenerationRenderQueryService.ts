import type {
  ListUnfinishedSceneGenerationsDTO,
  SceneGenerationScopeDTO
} from '../dto/SceneGenerationDTO'
import type {
  SceneGenerationRenderProgressEventVO,
  SceneGenerationRenderStatusVO,
  SceneGenerationTimelineEntryVO,
  SceneGenerationUnfinishedPageVO
} from '../vo/SceneGenerationRenderVO'

export type Unsubscribe = () => void

export interface SceneGenerationRenderQueryService {
  /**
   * 只读返回渲染安全状态。不续跑，不隐式写作品；断线后以本次查询为准。
   * 仓储确认操作不存在时失败信封带 `sceneGenerationOperationMissing`；
   * 检查点缺失、损坏、身份不符或读取失败不带该原因。
   * @throws {AppException} 操作不存在或身份不匹配。
   */
  getSceneGenerationRenderStatus(
    request: SceneGenerationScopeDTO
  ): Promise<SceneGenerationRenderStatusVO>

  subscribeSceneGenerationProgress(
    request: SceneGenerationScopeDTO,
    publish: (event: SceneGenerationRenderProgressEventVO) => void
  ): Unsubscribe

  listSceneGenerationTimeline(
    request: SceneGenerationScopeDTO
  ): Promise<readonly SceneGenerationTimelineEntryVO[]>

  findLatestSceneGeneration(request: {
    projectId: string
    sceneId: string
  }): Promise<SceneGenerationRenderStatusVO | null>

  /**
   * 只读分页列出需要作者显式处理的操作：尚未结束且没有检查点的遗留，
   * 以及带检查点但写入/提交回执待核对的中断。单条检查点读取失败只降级该条，
   * 不拖垮整页。本查询不恢复、不写状态、不调用模型。
   * @throws {AppException} 身份越界、页大小或游标无效，或执行记录读取失败。
   */
  listUnfinishedSceneGenerations(
    request: ListUnfinishedSceneGenerationsDTO
  ): Promise<SceneGenerationUnfinishedPageVO>
}
