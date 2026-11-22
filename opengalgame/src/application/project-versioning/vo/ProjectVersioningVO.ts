export type WorkBaselineVO = {
  baselineRef: string
  revisionRef: string
}

export type PreparedVersionOperationVO = {
  operationId: string
  baselineRef: string
  revisionRef: string
}

export type CallerVersionOperationVO = {
  projectId: string
  sourceModule: string
  callerOperationId: string
  operationId: string
  state: 'pending' | 'notStarted' | 'committed' | 'notCommitted'
}

export type VersionCommitVO = {
  operationId: string
  state: '已提交' | '无变更'
  revisionRef: string
}

export type CallerOperationState =
  | 'pending'
  | 'notStarted'
  | 'committed'
  | 'notCommitted'

export type VersionSettlementVO = { operationId: string } & (
  | { state: '已提交'; revisionRef: string }
  | { state: '无变更'; revisionRef: string }
  | { state: '未提交' }
  | { state: '待回退'; revisionRef: string }
  | { state: '已回退'; originalRevisionRef: string; revisionRef: string }
  | { state: '待核对' }
)

export type VersionRollbackVO = {
  operationId: string
  state: '已回退'
  revisionRef: string
}
