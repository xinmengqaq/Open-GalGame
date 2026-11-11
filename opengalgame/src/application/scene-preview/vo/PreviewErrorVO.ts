export type PreviewErrorCode =
  | 'invalidRequest'
  | 'sceneUnavailable'
  | 'sceneArtifactMissing'
  | 'contentUnreadable'
  | 'sessionNotFound'
  | 'sessionClosed'
  | 'prepareAlreadyDone'
  | 'prepareFailed'
  | 'runtimeNotPrepared'
  | 'runtimeNotReady'
  | 'runtimeDisconnected'
  | 'commandTimeout'
  | 'staleRuntimeGeneration'
  | 'branchChoiceRequired'
  | 'locateNotReached'
  | 'positionCaptureFailed'
  | 'restoreFailed'
  | 'restoreTargetMissing'
  | 'restorePositionMismatch'
  | 'playbackCompleted'
  | 'contentBasisChanged'
  | 'contentLocked'
  | 'dialogueObjectInvalid'
  | 'saveRequestReused'
  | 'saveOutcomeUnknown'
  | 'saveNotConfirmed'
  | 'saveSettlementConflict'
  | 'previewUpdatePending'
  | 'engineCapabilityUnavailable'

export type PreviewRecoveryAction =
  'retry' | 'retryPreviewUpdate' | 'querySettlement' | 'prepare' | 'replay' | 'reopen' | 'none'

export type PreviewErrorVO = {
  readonly code: PreviewErrorCode
  readonly message: string
  readonly dialogueId?: string
  readonly recovery: PreviewRecoveryAction
}
