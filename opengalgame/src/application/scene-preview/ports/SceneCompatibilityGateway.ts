import type { SceneCompatibilityFacts } from '../models/SceneCompatibilityFacts'

export interface SceneCompatibilityGateway {
  readSceneCompatibility(): Promise<SceneCompatibilityFacts>
}
