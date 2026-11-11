import type { SceneCompatibilityFacts } from '../models/SceneCompatibilityFacts'

export interface SceneCompatibilityGateway {
  /**
   * 返回本次解析使用的解析器和引擎版本。
   * @throws {AppException} 版本事实不可用。不读取脚本，不启动引擎。
   */
  readSceneCompatibility(): Promise<SceneCompatibilityFacts>
}
