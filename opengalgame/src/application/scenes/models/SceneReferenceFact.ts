export type SceneReferenceStatus = 'present' | 'missing' | 'external' | 'invalid-path' | 'cleared'

export type SceneReferenceFact = {
  readonly rawReference: string
  readonly runtimeReference: string
  readonly relativePath?: string
  readonly kind: string
  readonly status: SceneReferenceStatus
  readonly sourceLine: number
}
