import type { ExternalContentStore } from '../context/FileContextContentStore'
import type { ExecutionBudget } from '../execution/ExecutionBudget'
import type { AgentStreamObservation } from '../streaming/AgentStreamEvent'
import type { AgentProgressObserver } from '../execution/AgentProgress'

export interface WorkspaceBinding {
  root: string
  writable: boolean
  writablePaths?: readonly string[]
}

export interface AgentExecutionIdentity {
  executionId: string
}

export interface AgentStateScope {
  threadId: string
  checkpointId?: string
}

export type AgentExecutionMode = 'generate' | 'repair' | 'finalize'

export interface AgentRunContext {
  budget: ExecutionBudget
  workspace?: WorkspaceBinding
  contentStore?: ExternalContentStore
  requiredMessageIds?: readonly string[]
  progress?: AgentProgressObserver
  /** 本次生成或修复。缺失时按生成处理，不从提示文本推断。 */
  executionMode?: AgentExecutionMode
  /** 当前权威候选文件集合。本轮新写入由 written-file ledger 单独记录，不以它判断候选是否存在。 */
  writtenFiles?: readonly string[]
}

export interface AgentExecution {
  observation?: AgentStreamObservation
  signal?: AbortSignal
  context: AgentRunContext
  identity: AgentExecutionIdentity
  scope: AgentStateScope
}
