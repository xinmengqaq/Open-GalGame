export type SceneFileKind = 'entry' | 'scene' | 'metadata' | 'asset'

export type SceneSourceFile = {
  readonly relativePath: string
  readonly kind: SceneFileKind
  readonly bytes: Uint8Array
  readonly text?: string
  readonly size: number
  readonly modifiedAtMs: number
  readonly digest: string
}

export type SceneSourceSnapshot = {
  readonly projectRoot: string
  readonly entryFile: SceneSourceFile
  readonly files: readonly SceneSourceFile[]
  readonly missingMetadataFiles: readonly string[]
  readonly digest: string
}

export type ReadSceneSourceRequest = {
  readonly projectRoot: string
  readonly entryFile?: string
  readonly sceneFiles?: readonly string[]
  readonly metadataFiles?: readonly string[]
}
