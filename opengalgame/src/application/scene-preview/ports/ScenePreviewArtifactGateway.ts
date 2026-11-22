import type { SceneIdentity } from '@domain/scenes/models/SceneIdentity'

export type ScenePreviewArtifactReport =
  | { readonly status: 'available' }
  | { readonly status: 'missing' }
  | { readonly status: 'unreadable' }

export interface ScenePreviewArtifactGateway {
  readSceneArtifact(scene: SceneIdentity): Promise<ScenePreviewArtifactReport>
}
