import type { PreparedOperationBinding } from '../models/PreparedOperationBinding'
import {
  requireContentFingerprint,
  requireOperationId,
  requireOwnedPaths
} from './versionProtocolGuards'

export function bindPreparedOperation(input: {
  readonly operationId: string
  readonly contentFingerprint: string
  readonly changePaths: readonly string[]
  readonly watchedPaths: readonly string[]
}): PreparedOperationBinding {
  requireOwnedPaths(input.changePaths, input.changePaths, input.watchedPaths)
  return {
    operationId: requireOperationId(input.operationId),
    contentFingerprint: requireContentFingerprint(input.contentFingerprint)
  }
}
