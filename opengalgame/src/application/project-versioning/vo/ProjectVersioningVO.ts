/** 可靠作品基线。只在后端流转。 */
export type WorkBaselineVO = {
  baselineRef: string
  revisionRef: string
}

/** 已持久绑定的操作身份和基线。 */
export type PreparedVersionOperationVO = {
  operationId: string
  baselineRef: string
  revisionRef: string
}

/** 调用方操作身份对应的版本身份。只在后端流转。 */
export type CallerVersionOperationVO = {
  projectId: string
  sourceModule: string
  callerOperationId: string
  operationId: string
}

/** 可靠提交结果。无变更也必须对应已核对的作品版本。 */
export type VersionCommitVO = {
  operationId: string
  state: '已提交' | '无变更'
  revisionRef: string
}

/**
 * 操作结算。
 * 字段随状态收窄，不使用可空组合表示缺失事实。
 */
export type VersionSettlementVO = { operationId: string } & (
  | { state: '已提交'; revisionRef: string }
  | { state: '无变更'; revisionRef: string }
  | { state: '未提交' }
  | { state: '待回退'; revisionRef: string }
  | { state: '已回退'; originalRevisionRef: string; revisionRef: string }
  | { state: '待核对' }
)

/** 已追加的回退提交，或同一操作已经可靠回退的事实。 */
export type VersionRollbackVO = {
  operationId: string
  state: '已回退'
  revisionRef: string
}
