import type { SceneSourceLocation } from '../../scenes/models/SceneSourceLocation'

/**
 * 当前工程和场景的生产上下文。
 * 具体登记解析由基础设施实现，应用层不读取静态测试登记。
 */
export interface SceneGenerationProductionContext {
  /**
   * 解析已登记的工程和场景位置。
   * @throws {AppException} 当前工程场景未登记或位置不可用。
   */
  resolveRegisteredScene(scene: {
    projectId: string
    sceneId: string
  }): Promise<SceneSourceLocation>
}
