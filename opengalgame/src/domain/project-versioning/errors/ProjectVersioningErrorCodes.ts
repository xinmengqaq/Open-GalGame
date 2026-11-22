export const ProjectVersioningErrorCodes = {
  gitNotRepository: 5201,
  gitUnavailable: 5202,
  gitNoCommits: 5203,
  gitQueryFailed: 5204,
  invalidOperationIdentity: 5301,
  invalidContentFingerprint: 5302,
  contentFingerprintConflict: 5303,
  pathOutOfScope: 5304,
  watchedPathNotWritable: 5305,
  operationOwnershipMismatch: 5306,
  illegalStateTransition: 5307,
  insufficientEvidence: 5308
} as const

export type ProjectVersioningErrorCode =
  (typeof ProjectVersioningErrorCodes)[keyof typeof ProjectVersioningErrorCodes]
