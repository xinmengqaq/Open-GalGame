import type { SceneGenerationInputsDTO, SceneInputSelectionDTO } from '../dto/SceneGenerationDTO'
import type { SceneSourceLocation } from '../../scenes/models/SceneSourceLocation'

export interface SceneInputGateway {
  /**
   * 按已登记的工程与场景身份取得受限位置，不接受调用方任意路径。
   * @throws {AppException} 工程身份不匹配、场景不存在或文件位置不可用。
   */
  locateScene(scene: { projectId: string; sceneId: string }): Promise<SceneSourceLocation>

  /**
   * 读取已保存编排，重新读取真实文档和素材，并保留提示词卡片正文。
   * @returns 不含画布展示状态和凭据的输入快照。
   * @throws {AppException} 编排或来源不存在、素材路径越界或读取失败。
   */
  readInputs(
    source: SceneSourceLocation,
    selection: SceneInputSelectionDTO
  ): Promise<SceneGenerationInputsDTO>
}
