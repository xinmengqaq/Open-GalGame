import type { VersionProtocolState } from './VersionProtocolState'

/**
 * 一次操作已被应用层核实的持久事务事实。
 * 内容指纹用于拒绝换内容复用；本类型不保存路径或技术修订。
 */
export interface VersionTransactionFact {
  readonly operationId: string
  readonly contentFingerprint: string
  readonly state: VersionProtocolState
}
