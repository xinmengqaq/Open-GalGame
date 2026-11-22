import type {
  ForkSceneGenerationFromHistoryDTO,
  RetrySceneGenerationRepairDTO,
  StartSceneGenerationDTO
} from '../dto/SceneGenerationDTO'
import type {
  SceneGenerationForkVO,
  SceneGenerationRenderStatusVO
} from '../vo/SceneGenerationRenderVO'

export interface SceneGenerationLaunchService {
  startSceneGeneration(request: StartSceneGenerationDTO): Promise<SceneGenerationRenderStatusVO>

  retrySceneGenerationRepair(
    request: RetrySceneGenerationRepairDTO
  ): Promise<SceneGenerationRenderStatusVO>

  /**
   * 从 AI 历史的可复制边界建立新操作和分支。新操作身份由应用层生成；
   * 来源身份、候选、输入与副作用在应用服务内重新证明，失败不改动来源。
   * @returns 新操作的安全渲染状态和用户可读来源摘要。
   * @throws {AppException} 来源不可复制、线程占用或身份不一致。
   */
  forkSceneGeneration(
    request: ForkSceneGenerationFromHistoryDTO
  ): Promise<SceneGenerationForkVO>
}
