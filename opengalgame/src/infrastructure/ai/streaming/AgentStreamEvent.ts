export type AgentTokenUsage = {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

export type AgentStreamError = {
  category: 'execution' | 'model' | 'tool'
  message: string
}

export type AgentStreamAssociation = {
  executionId: string
  agentId: string
  runId: string
  sequence: number
  timestamp: number
  sourceSequence?: number
  namespace?: readonly string[]
  parentRunId?: string
  messageId?: string
  toolCallId?: string
}

export type AgentRunStatus = 'started' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'

export type AgentStreamEvent = AgentStreamAssociation &
  (
    | { type: 'run'; status: AgentRunStatus; durationMs?: number; error?: AgentStreamError }
    | {
        type: 'model'
        status: 'started' | 'succeeded' | 'failed'
        modelName?: string
        durationMs?: number
        usage?: AgentTokenUsage
        error?: AgentStreamError
      }
    | {
        type: 'tool'
        status: 'started' | 'progress' | 'succeeded' | 'failed' | 'interrupted'
        toolName?: string
        durationMs?: number
        error?: AgentStreamError
      }
    | { type: 'text'; text: string }
    | {
        type: 'state'
        channel: 'updates' | 'input'
        node?: string
        status: 'updated' | 'interrupted'
      }
  )

export type AgentStreamSubscriber = (event: AgentStreamEvent) => void | Promise<void>

export type AgentStreamSubscription = {
  onEvent: AgentStreamSubscriber
  signal?: AbortSignal
}

export type AgentStreamObservation = {
  subscriptions?: readonly AgentStreamSubscription[]
  textDeltas?: boolean
}
