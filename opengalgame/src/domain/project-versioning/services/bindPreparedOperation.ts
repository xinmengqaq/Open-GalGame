import type { PreparedOperationBinding } from '../models/PreparedOperationBinding'
import {
  requireContentFingerprint,
  requireOperationId,
  requireOwnedPaths
} from './versionProtocolGuards'

/**
 * 固定准备操作的身份和内容指纹，并确认观察路径没有写入权。
 * 不读取基线，也不保留路径集合。
 * @throws {AppException} 身份、指纹或声明范围不成立。
 */
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
