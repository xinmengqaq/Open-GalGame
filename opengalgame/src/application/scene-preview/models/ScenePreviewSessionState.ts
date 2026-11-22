import type { ScenePreviewSourceFact } from './ScenePreviewSourceFact'

export type ScenePreviewSessionState = {
  readonly previewSessionId: string
  readonly source: ScenePreviewSourceFact
  readonly runtimeGeneration: number
  readonly lastSequence: number
  readonly prepared: boolean
  readonly closed: boolean
  readonly currentDialogueId?: string
}
