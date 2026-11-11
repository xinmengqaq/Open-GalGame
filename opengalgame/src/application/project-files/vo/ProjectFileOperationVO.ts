export type ProjectFileOperationSettlement = 'committed' | 'notCommitted' | 'unsettled'

export type ProjectFileOperationSettlementVO = {
  operationId: string
  settlement: ProjectFileOperationSettlement
}
