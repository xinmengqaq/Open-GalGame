import type { ResumeSceneGenerationDTO, SceneGenerationScopeDTO } from '../dto/SceneGenerationDTO'
import type { SceneGenerationRenderStatusVO } from '../vo/SceneGenerationRenderVO'

export interface SceneGenerationControlService {
  /**
   * 只记录暂停意图。暂停必须等到安全检查点，不能在模型调用或候选写入中途强制中断。
   * @throws {AppException} 操作不存在、身份不匹配或当前状态不能安全暂停。
   */
  pauseSceneGeneration(request: SceneGenerationScopeDTO): Promise<SceneGenerationRenderStatusVO>

  /**
   * 按操作、线程分支、检查点和候选修订恢复。提交结果不明不能按普通暂停恢复。
   * @throws {AppException} 恢复依据不完整、身份过期、基线冲突或提交结果不明。
   */
  resumeSceneGeneration(request: ResumeSceneGenerationDTO): Promise<SceneGenerationRenderStatusVO>

  /**
   * 取消前先核对提交副作用。已经提交的作品保留成功结果。
   * @throws {AppException} 操作不存在、提交结果不明或清理失败。
   */
  cancelSceneGeneration(request: SceneGenerationScopeDTO): Promise<SceneGenerationRenderStatusVO>
}
