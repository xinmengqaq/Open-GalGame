/**
 * 版本模块错误码。
 * 5201–5204 承接既有共享 Git 技术失败，数值不变。
 * 5301 起是本模块协议规则失败，不复用场景生成或工程文件错误码。
 */
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
