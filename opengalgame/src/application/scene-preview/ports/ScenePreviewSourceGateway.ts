import type { SceneIdentity } from '@domain/scenes/models/SceneIdentity'

import type { ScenePreviewSourceFact } from '../models/ScenePreviewSourceFact'

export interface ScenePreviewSourceGateway {
  readScenePreviewSource(scene: SceneIdentity): Promise<ScenePreviewSourceFact>
}
