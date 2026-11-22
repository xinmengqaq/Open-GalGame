import type { VersionProtocolState } from '../models/VersionProtocolState'
import type { VersionTransactionFact } from '../models/VersionTransactionFact'
import { requireOperationId, requireOwnedFact } from './versionProtocolGuards'

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
