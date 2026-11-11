import type {
  RetrySceneGenerationRepairDTO,
  StartSceneGenerationDTO
} from '../dto/SceneGenerationDTO'
import type { SceneGenerationRenderStatusVO } from '../vo/SceneGenerationRenderVO'

export interface SceneGenerationLaunchService {
  /**
   * 保存当前画布后启动一次生成。保存失败或结果不明时不得创建执行、候选或模型调用。
   * B 版启动固定要求候选审阅，调用方不能改写该门槛。
   * @throws {AppException} 身份不合法、保存失败、保存结果不明、基线或锁定事实不足。
   */
  startSceneGeneration(request: StartSceneGenerationDTO): Promise<SceneGenerationRenderStatusVO>

  /**
   * 从已失败的修复阶段新建操作。携带确认修改正文，并把来源候选物化为本轮只读输入。
   * 来源不可读、身份不匹配或仍在运行时拒绝，不回退为空白生成。
   * @throws {AppException} 来源终态、候选归属或确认正文不能证明。
   */
  retrySceneGenerationRepair(
    request: RetrySceneGenerationRepairDTO
  ): Promise<SceneGenerationRenderStatusVO>
}
