import type { SceneGenerationScopeDTO } from '../dto/SceneGenerationDTO'
import type {
  SceneGenerationRenderProgressEventVO,
  SceneGenerationRenderStatusVO,
  SceneGenerationTimelineEntryVO
} from '../vo/SceneGenerationRenderVO'

export type Unsubscribe = () => void

export interface SceneGenerationRenderQueryService {
  /**
   * 只读返回渲染安全状态。不续跑，不隐式写作品；断线后以本次查询为准。
   * @throws {AppException} 操作不存在或身份不匹配。
   */
  getSceneGenerationRenderStatus(
    request: SceneGenerationScopeDTO
  ): Promise<SceneGenerationRenderStatusVO>

  /**
   * 订阅当前操作的安全进度。事件只刷新界面，不能证明提交成功。
   * @throws {AppException} 操作不存在或身份不匹配。
   */
  subscribeSceneGenerationProgress(
    request: SceneGenerationScopeDTO,
    publish: (event: SceneGenerationRenderProgressEventVO) => void
  ): Unsubscribe

  /**
   * 读取有限安全时间线。不返回模型原文、工具参数、路径或内部异常。
   * @throws {AppException} 操作不存在或身份不匹配。
   */
  listSceneGenerationTimeline(
    request: SceneGenerationScopeDTO
  ): Promise<readonly SceneGenerationTimelineEntryVO[]>

  /**
   * 只读返回当前场景最近一次操作的安全状态，不要求该操作已有检查点，不续跑也不写作品。
   * 用于刷新或历史为空时恢复运行中、等待模型的状态；没有执行记录时返回 null。
   * @throws {AppException} 身份越界或执行记录读取失败。
   */
  findLatestSceneGeneration(request: {
    projectId: string
    sceneId: string
  }): Promise<SceneGenerationRenderStatusVO | null>
}
