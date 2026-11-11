export type ScenePreviewAvailabilityVO =
  | { readonly status: 'available' }
  | {
      readonly status: 'blocked'
      readonly reason: 'noArtifact' | 'sceneUnavailable' | 'readUnavailable'
      readonly message: string
    }
