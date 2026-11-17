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
  /** 安全失败分类。只来自执行记录或旧原因映射，不暴露诊断分类。 */
  failureClass?: FailureClass
  /** 按失败分类给出的下一步动作，主动作在前。 */
  nextActions?: readonly NextAction[]
  reference?: string
  unverified?: boolean
  candidateSnapshotId?: string
  previewAuthorization?: SceneGenerationCandidatePreviewAuthorization
}
