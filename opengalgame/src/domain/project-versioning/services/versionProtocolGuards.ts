import { OPERATION_ID_PATTERN } from '@common/contracts/OperationId'
import { AppException } from '@common/errors/AppException'
import { ProjectVersioningErrorCodes } from '../errors/ProjectVersioningErrorCodes'
import type { VersionTransactionFact } from '../models/VersionTransactionFact'

const FINGERPRINT_PATTERN = /^[^\s]{1,256}$/u

/**
 * 操作身份只接受既有公共格式，不另建标识类型。
 * @throws {AppException} 身份为空或不符合公共格式。
 */
export function requireOperationId(operationId: string): string {
  if (typeof operationId !== 'string' || !OPERATION_ID_PATTERN.test(operationId)) {
    throw new AppException({
      code: ProjectVersioningErrorCodes.invalidOperationIdentity,
      msg: '操作身份不正确'
    })
  }
  return operationId
}

/**
 * 内容指纹是应用层给出的稳定摘要，领域层不解释其算法。
 * @throws {AppException} 指纹为空或含空白。
 */
export function requireContentFingerprint(contentFingerprint: string): string {
  if (typeof contentFingerprint !== 'string' || !FINGERPRINT_PATTERN.test(contentFingerprint)) {
    throw new AppException({
      code: ProjectVersioningErrorCodes.invalidContentFingerprint,
      msg: '内容指纹不正确'
    })
  }
  return contentFingerprint
}

/**
 * 持久事实必须属于当前操作，且自身证据完整。
 * 缺失事实由调用方决定是待核对还是允许继续，不在这里改判。
 * @throws {AppException} 事实属于其他操作，或缺少可核对指纹。
 */
export function requireOwnedFact(
  operationId: string,
  fact: VersionTransactionFact
): VersionTransactionFact {
  requireOperationId(fact.operationId)
  if (fact.operationId !== operationId) {
    throw new AppException({
      code: ProjectVersioningErrorCodes.operationOwnershipMismatch,
      msg: '操作事实不属于当前操作'
    })
  }
  requireContentFingerprint(fact.contentFingerprint)
  return fact
}

/**
 * 声明路径按原样比较。重复、空白和越界都不能取得写入权。
 * 观察路径即使被放进允许集合，也不能成为本次写入路径。
 * @throws {AppException} 路径重复、空白、越出声明范围，或观察路径被写入。
 */
export function requireOwnedPaths(
  requestedPaths: readonly string[],
  allowedPaths: readonly string[],
  watchedPaths: readonly string[] = []
): void {
  const allowed = uniquePaths(allowedPaths, '声明路径不正确')
  const watched = new Set(uniquePaths(watchedPaths, '观察路径不正确'))
  const requested = uniquePaths(requestedPaths, '请求路径不正确')
  for (const path of requested) {
    if (watched.has(path)) {
      throw new AppException({
        code: ProjectVersioningErrorCodes.watchedPathNotWritable,
        msg: '观察路径不能写入'
      })
    }
    if (!allowed.has(path)) {
      throw new AppException({
        code: ProjectVersioningErrorCodes.pathOutOfScope,
        msg: '请求路径超出本操作范围'
      })
    }
  }
}

function uniquePaths(paths: readonly string[], message: string): Set<string> {
  if (!Array.isArray(paths)) {
    throw new AppException({
      code: ProjectVersioningErrorCodes.pathOutOfScope,
      msg: message
    })
  }
  const unique = new Set<string>()
  for (const path of paths) {
    if (typeof path !== 'string' || path.trim() === '' || path !== path.trim()) {
      throw new AppException({
        code: ProjectVersioningErrorCodes.pathOutOfScope,
        msg: message
      })
    }
    if (unique.has(path)) {
      throw new AppException({
        code: ProjectVersioningErrorCodes.pathOutOfScope,
        msg: '同一操作不能重复声明路径'
      })
    }
    unique.add(path)
  }
  return unique
}
