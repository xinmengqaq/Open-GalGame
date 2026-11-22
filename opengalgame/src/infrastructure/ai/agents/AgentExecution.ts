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
  executionMode?: AgentExecutionMode
  writtenFiles?: readonly string[]
}

export interface AgentExecution {
  observation?: AgentStreamObservation
  signal?: AbortSignal
  context: AgentRunContext
  identity: AgentExecutionIdentity
  scope: AgentStateScope
}
