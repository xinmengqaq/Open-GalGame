import type { ParsedScene } from '../models/ParsedScene'
import type { SceneReferenceFact } from '../models/SceneReferenceFact'
import type { SceneSourceSnapshot } from '../models/SceneSourceSnapshot'

export interface SceneAssetReferenceGateway {
  checkSceneAssetReferences(
    snapshot: SceneSourceSnapshot,
    scene: ParsedScene
  ): Promise<readonly SceneReferenceFact[]>
}
