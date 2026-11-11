import type { SceneContentBasisVO } from '../vo/ScenePreviewSessionVO'

export type DialogueTextEditDTO = {
  readonly dialogueId: string
  readonly text: string
}

export type PreviewDialogueDraftDTO = {
  readonly previewSessionId: string
  readonly expectedRuntimeGeneration: number
  readonly dialogueId: string
  readonly editRevision: number
  readonly text: string
}

export type SaveDialogueChangesDTO = {
  readonly previewSessionId: string
  readonly requestId: string
  readonly baseContentBasis: SceneContentBasisVO
  readonly edits: readonly DialogueTextEditDTO[]
}

export type ReadDialogueSaveSettlementDTO = {
  readonly projectId: string
  readonly sceneId: string
  readonly requestId: string
}

export type RetryPreviewUpdateDTO = {
  readonly previewSessionId: string
  readonly requestId: string
}
