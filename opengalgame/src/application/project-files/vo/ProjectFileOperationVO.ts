export type ProjectFileOperationSettlement =
  | 'committed'
  | 'notCommitted'
  | 'notStarted'
  | 'unsettled'

export type ProjectFileOperationSettlementVO = {
  operationId: string
  settlement: ProjectFileOperationSettlement
  /** caller link 是否存在；unlinked 不证明操作未执行。 */
  linked: boolean
}

export type ProjectFileOperationRecoveryVO = {
  operationId: string
  state: 'pending' | 'notStarted' | 'committed' | 'notCommitted'
}
