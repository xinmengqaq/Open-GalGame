import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import {
  ScenePreviewErrorCodes,
  scenePreviewErrorMessages,
  type ScenePreviewErrorCode
} from '@domain/scene-preview/errors/ScenePreviewErrorCodes'

import type { CandidatePreviewSessionResolution } from '../../../scenes/models/CandidatePreviewSession'

const rejectionCodes = {
  missing: ScenePreviewErrorCodes.candidateSessionMissing,
  expired: ScenePreviewErrorCodes.candidateSessionExpired,
  mismatch: ScenePreviewErrorCodes.candidateSessionMismatch
} as const

export function candidateSessionRejection(
  resolution: Extract<CandidatePreviewSessionResolution, { status: 'rejected' }>
): AppException {
  return candidateFailure(rejectionCodes[resolution.reason])
}

export function candidateSourceFailure(error: unknown): AppException {
  if (!(error instanceof AppException))
    return candidateFailure(ScenePreviewErrorCodes.candidateSourceUnavailable)
  if (error.code === ErrorCodes.forbidden) {
    return candidateFailure(ScenePreviewErrorCodes.candidateSourceForbidden, error)
  }
  if (error.code === ErrorCodes.operationConflict) {
    return candidateFailure(ScenePreviewErrorCodes.candidateSourceChanged, error)
  }
  return candidateFailure(ScenePreviewErrorCodes.candidateSourceUnavailable, error)
}

export function candidateCompatibilityFailure(cause: unknown): AppException {
  return candidateFailure(ScenePreviewErrorCodes.candidateCompatibilityUnavailable, cause)
}

export function isCandidateSourceUnavailable(error: unknown): boolean {
  return error instanceof AppException && error.code === ErrorCodes.internalError
}

function candidateFailure(code: ScenePreviewErrorCode, cause?: unknown): AppException {
  return new AppException({ code, msg: scenePreviewErrorMessages[code], cause })
}
