import type {
  CloseSceneGenerationCandidatePreviewDTO,
  OpenSceneGenerationCandidatePreviewDTO
} from '../dto/SceneGenerationDTO'

import type { SceneGenerationCandidatePreviewVO } from '../vo/SceneGenerationRenderVO'

export interface SceneGenerationCandidatePreviewService {
  /**
   * 只接受当前操作或历史检查点中真实存在的候选修订，返回短生命周期只读会话。
   * @throws {AppException} 候选修订不存在、不属于当前范围，或预览会话不能建立。
   */
  openSceneGenerationCandidatePreview(
    request: OpenSceneGenerationCandidatePreviewDTO
  ): Promise<SceneGenerationCandidatePreviewVO>

  /**
   * 关闭指定预览会话并释放其资源。候选变化后的旧会话必须视为失效。
   * @throws {AppException} 会话不存在、不属于当前操作，或关闭失败。
   */
  closeSceneGenerationCandidatePreview(
    request: CloseSceneGenerationCandidatePreviewDTO
  ): Promise<void>
}
