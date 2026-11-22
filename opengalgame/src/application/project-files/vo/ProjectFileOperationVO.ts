export type ProjectFileOperationSettlement =
  | 'committed'
  | 'notCommitted'
  | 'notStarted'
  | 'unsettled'

export type ProjectFileOperationSettlementVO = {
  operationId: string
  settlement: ProjectFileOperationSettlement
  linked: boolean
}

export type ProjectFileOperationRecoveryVO = {
  operationId: string
  state: 'pending' | 'notStarted' | 'committed' | 'notCommitted'
}
