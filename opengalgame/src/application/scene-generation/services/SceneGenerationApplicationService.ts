import type {
  ForkSceneGenerationDTO,
  GenerateSceneDTO,
  ReplySceneGenerationInteractionDTO,
  RetrySceneGenerationRepairDTO,
  SceneGenerationScopeDTO
} from '../dto/SceneGenerationDTO'
import type {
  SceneGenerationOperationVO,
  SceneGenerationReplyReceiptVO,
  SceneGenerationStatusVO
} from '../vo/SceneGenerationVO'

export interface SceneGenerationApplicationService {
  /**
   * @throws {AppException} 输入不合法、操作冲突或线程尚有未结束操作。
   */
  generateScene(request: GenerateSceneDTO): Promise<SceneGenerationOperationVO>

  /**
   * 直接中止当前工作流或结束等待、待恢复操作，先核对提交结果。
   * @param request - 要取消的操作身份。
   * @returns 持久状态；已提交作品保留成功结果。
   * @throws {AppException} 操作不存在、提交结果不明或清理失败。
   */
  cancelSceneGeneration(request: SceneGenerationScopeDTO): Promise<SceneGenerationStatusVO>

  /**
   * 核对等待、候选与基线，先持久接受回复再继续，重复回复返回已有接受凭证。
   * @returns 不依赖后续执行成败的接受凭证。
   * @throws {AppException} 回复过期、不允许、身份重用或基线冲突。
   */
  replySceneGenerationInteraction(
    request: ReplySceneGenerationInteractionDTO
  ): Promise<SceneGenerationReplyReceiptVO>

  /**
   * @param request - 操作身份，不接受调用方指定恢复路径。
   * @returns 已核对的状态，重复恢复不重复派发。
   * @throws {AppException} 恢复依据不完整、基线冲突或提交结果不明。
   */
  resumeSceneGeneration(request: SceneGenerationScopeDTO): Promise<SceneGenerationStatusVO>

  /**
   * 从完整历史点创建新分支与操作，恢复独立候选，不回退正式工程或修改原分支。
   * @throws {AppException} 历史不可继续、线程占用或身份冲突。
   */
  forkSceneGeneration(request: ForkSceneGenerationDTO): Promise<SceneGenerationOperationVO>

  /**
   * 为已失败的修复阶段创建新操作、线程和分支。
   * 显式修复模式与来源身份一起持久化；旧候选标识不进入新工作区。
   * @throws {AppException} 来源不可用、正文未确认或线程仍有未结束操作。
   */
  retryFailedRepair(
    request: RetrySceneGenerationRepairDTO & { operationId: string }
  ): Promise<SceneGenerationOperationVO>
}
