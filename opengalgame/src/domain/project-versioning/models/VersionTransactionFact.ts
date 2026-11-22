import type { VersionProtocolState } from './VersionProtocolState'

export interface VersionTransactionFact {
  readonly operationId: string
  readonly contentFingerprint: string
  readonly state: VersionProtocolState
}
