export type SceneContentBasisVO = {
  readonly digest: string
  readonly parserVersion: string
  readonly engineVersion: string
}

export type ScenePreviewLockState = 'editable' | 'locked' | 'unknown'

export type ScenePreviewIssueCode =
  | 'missingStableId'
  | 'duplicateStableId'
  | 'unresolvedStep'
  | 'lockMetadataMissing'
  | 'unsupportedStatement'
  | 'unsupportedParameter'
  | 'missingAsset'
  | 'invalidAssetReference'

export type ScenePreviewIssueVO = {
  readonly code: ScenePreviewIssueCode
  readonly message: string
  readonly dialogueId?: string
}

export type SceneDialogueVO = {
  readonly dialogueId: string
  readonly text: string
  readonly editable: boolean
}

export type ScenePreviewSessionVO = {
  readonly previewSessionId: string
  readonly projectId: string
  readonly sceneId: string
  readonly sceneName: string
  readonly contentBasis: SceneContentBasisVO
  readonly lockState: ScenePreviewLockState
  readonly dialogues: readonly SceneDialogueVO[]
  readonly issues: readonly ScenePreviewIssueVO[]
}
