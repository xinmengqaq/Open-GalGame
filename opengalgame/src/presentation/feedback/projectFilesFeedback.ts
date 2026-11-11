import type { FailureState } from './failure'

/** 工程身份不匹配。 */
export const OWNERSHIP_MISMATCH_CODE = 4319
/** 画布或来源内容损坏。 */
export const CONTENT_DAMAGED_CODE = 4314
/** 格式不受支持。 */
export const UNSUPPORTED_FORMAT_CODE = 4315
export const READ_CHANGED_CODE = 4317
/** 工程文件无法读取。 */
export const READ_FAILED_CODE = 4318
/** 作品提交结果不明。 */
export const COMMIT_UNCLEAR_CODE = 4326

/**
 * @param code - 失败码。
 */
export function isOwnershipMismatch(code: number): boolean {
  return code === OWNERSHIP_MISMATCH_CODE
}

/**
 * 是否应按画布损坏处理，而不是空画布。
 * @param code - 失败码。
 */
export function isArrangementUnreadable(code: number): boolean {
  return (
    code === CONTENT_DAMAGED_CODE ||
    code === UNSUPPORTED_FORMAT_CODE ||
    code === READ_CHANGED_CODE ||
    code === READ_FAILED_CODE
  )
}

/**
 * 取可展示的工程文件失败说明。
 * @param failure - 结构化失败。
 */
export function projectFilesFailureMessage(failure: FailureState): string {
  return failure.msg
}
