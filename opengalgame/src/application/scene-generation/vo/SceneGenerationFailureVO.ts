export type SceneGenerationFailureReason =
  | 'noInformationGain'
  | 'missingCandidateWrite'
  | 'outputTruncated'
  | 'missingStructuredResult'
  | 'structuredOutput'
  | 'modelFailure'
  | 'modelRejected'
  | 'modelAccess'
  | 'contextOverflow'
  | 'correctionsExhausted'

export type SceneGenerationCandidatePreviewAuthorization = 'readOnly' | 'unavailable'

export type FailureClass =
  | 'inputInvalid'
  | 'blocked'
  | 'modelTransient'
  | 'modelAuth'
  | 'modelRejected'
  | 'contextOverflow'
  | 'outputContract'
  | 'noProgress'
  | 'correctionsExhausted'
  | 'internal'

export type NextAction =
  | 'retryOperation'
  | 'retryRepair'
  | 'regenerate'
  | 'checkConnection'
  | 'reviseRequirement'
  | 'reduceInput'
  | 'viewCandidate'
  | 'resume'
  | 'verifyTask'
  | 'returnToCanvas'
  | 'viewInputSummary'
  | 'discard'

export type SceneGenerationPublicFailure = {
  code: number
  message: string
  reason?: SceneGenerationFailureReason
  failureClass?: FailureClass
  nextActions?: readonly NextAction[]
  reference?: string
  unverified?: boolean
  candidateSnapshotId?: string
  previewAuthorization?: SceneGenerationCandidatePreviewAuthorization
}
