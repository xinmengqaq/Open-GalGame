import type { FailureState } from './failure'

export const OWNERSHIP_MISMATCH_CODE = 4319
export const CONTENT_DAMAGED_CODE = 4314
export const UNSUPPORTED_FORMAT_CODE = 4315
export const READ_CHANGED_CODE = 4317
export const READ_FAILED_CODE = 4318
export const COMMIT_UNCLEAR_CODE = 4326
export const COMMUNICATION_FAILED_CODE = 5102
export const CATALOG_WRITE_FAILED_CODE = 4329

export function isOwnershipMismatch(code: number): boolean {
  return code === OWNERSHIP_MISMATCH_CODE
}

export function isArrangementUnreadable(code: number): boolean {
  return (
    code === CONTENT_DAMAGED_CODE ||
    code === UNSUPPORTED_FORMAT_CODE ||
    code === READ_CHANGED_CODE ||
    code === READ_FAILED_CODE
  )
}

export function projectFilesFailureMessage(failure: FailureState): string {
  return failure.msg
}
