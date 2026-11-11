import { AppException } from '@common/errors/AppException'
import { ProjectVersioningErrorCodes } from '../errors/ProjectVersioningErrorCodes'
import type { VersionProtocolState } from '../models/VersionProtocolState'
import type { VersionTransactionFact } from '../models/VersionTransactionFact'
import {
  requireContentFingerprint,
  requireOperationId,
  requireOwnedFact,
  requireOwnedPaths
} from './versionProtocolGuards'

export type CommitTransition =
  | { readonly kind: 'continue' }
  | {
      readonly kind: 'existing'
      readonly state: Extract<VersionProtocolState, '已提交' | '无变更'>
    }

/**
 * 按原操作的持久事实决定能否继续提交。
 * 没有事实只表示应用层尚未取得可核对事实，不解释成安全重提。
 * @throws {AppException} 内容被替换、路径越界，或当前事实不允许提交。
 */
export function resolveCommitTransition(input: {
  readonly operationId: string
  readonly contentFingerprint: string
  readonly requestedPaths: readonly string[]
  readonly allowedPaths: readonly string[]
  readonly watchedPaths?: readonly string[]
  readonly fact: VersionTransactionFact | null
}): CommitTransition {
  const operationId = requireOperationId(input.operationId)
  const contentFingerprint = requireContentFingerprint(input.contentFingerprint)
  requireOwnedPaths(input.requestedPaths, input.allowedPaths, input.watchedPaths ?? [])
  if (input.fact === null) return { kind: 'continue' }

  const fact = requireOwnedFact(operationId, input.fact)
  if (fact.contentFingerprint !== contentFingerprint) {
    throw new AppException({
      code: ProjectVersioningErrorCodes.contentFingerprintConflict,
      msg: '同一操作不能更换内容'
    })
  }
  if (fact.state === '已提交' || fact.state === '无变更') {
    return { kind: 'existing', state: fact.state }
  }
  if (fact.state === '未提交') return { kind: 'continue' }
  throw new AppException({
    code: ProjectVersioningErrorCodes.illegalStateTransition,
    msg: fact.state === '待核对' ? '操作证据不足，不能继续提交' : '当前操作状态不能继续提交'
  })
}
