import { AppException } from '@common/errors/AppException'
import { ProjectVersioningErrorCodes } from '../errors/ProjectVersioningErrorCodes'
import type { VersionTransactionFact } from '../models/VersionTransactionFact'
import { requireOperationId, requireOwnedFact, requireOwnedPaths } from './versionProtocolGuards'

export type RollbackTransition =
  { readonly kind: 'continue' } | { readonly kind: 'existing'; readonly state: '已回退' }

/**
 * 回退和历史撤销共用本规则。
 * 只接受原操作拥有的路径；已回退返回既有事实，不授权再次回退。
 * @throws {AppException} 操作不符、路径越界、证据不足或不允许转换。
 */
export function resolveRollbackTransition(input: {
  readonly operationId: string
  readonly requestedPaths: readonly string[]
  readonly ownedPaths: readonly string[]
  readonly fact: VersionTransactionFact | null
}): RollbackTransition {
  const operationId = requireOperationId(input.operationId)
  requireOwnedPaths(input.requestedPaths, input.ownedPaths)
  if (input.fact === null) {
    throw new AppException({
      code: ProjectVersioningErrorCodes.insufficientEvidence,
      msg: '缺少回退事实，不能回退'
    })
  }
  const fact = requireOwnedFact(operationId, input.fact)
  if (fact.state === '已回退') return { kind: 'existing', state: '已回退' }
  if (fact.state === '待回退') return { kind: 'continue' }
  if (fact.state === '待核对') {
    throw new AppException({
      code: ProjectVersioningErrorCodes.insufficientEvidence,
      msg: '操作证据不足，不能回退'
    })
  }
  throw new AppException({
    code: ProjectVersioningErrorCodes.illegalStateTransition,
    msg: '当前操作状态不能回退'
  })
}
