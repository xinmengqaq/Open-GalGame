import type { VersionProtocolState } from '../models/VersionProtocolState'
import type { VersionTransactionFact } from '../models/VersionTransactionFact'
import { requireOperationId, requireOwnedFact } from './versionProtocolGuards'

/**
 * 将已核实事实规范为协议结算。
 * 没有事实保持待核对，不能解释成未提交后重试。
 * @throws {AppException} 事实不属于所给操作，或事实自身不能核对。
 */
export function resolveVersionSettlement(
  fact: VersionTransactionFact | null,
  operationId?: string
): VersionProtocolState {
  if (fact === null) {
    if (operationId !== undefined) requireOperationId(operationId)
    return '待核对'
  }
  requireOwnedFact(operationId ?? fact.operationId, fact)
  return fact.state
}
