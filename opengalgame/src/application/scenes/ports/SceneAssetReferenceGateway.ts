import type { ParsedScene } from '../models/ParsedScene'
import type { SceneReferenceFact } from '../models/SceneReferenceFact'
import type { SceneSourceSnapshot } from '../models/SceneSourceSnapshot'

export interface SceneAssetReferenceGateway {
  /**
   * 检查本次场景的引用，不下载、加载、播放或扫描全工程。
   * @returns 引用可达性事实，不代表可以解码或播放。
   * @throws {AppException} 内容依据不匹配或查询发生技术故障。
   */
  checkSceneAssetReferences(
    snapshot: SceneSourceSnapshot,
    scene: ParsedScene
  ): Promise<readonly SceneReferenceFact[]>
}
