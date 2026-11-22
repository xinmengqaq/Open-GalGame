import type { ExecutionBudgetUsage } from './ExecutionBudget'

export type AgentProgressEvent = {
  kind: 'model-start' | 'model-end' | 'tool-start' | 'tool-end' | 'completion-nudge'
  at: number
  usage: ExecutionBudgetUsage
  lastToolName?: string
  noNewInformationStreak?: number
}

export type AgentProgressObserver = (event: AgentProgressEvent) => void

export function notifyAgentProgress(
  observer: AgentProgressObserver | undefined,
  event: AgentProgressEvent
): void {
  if (!observer) return
  try {
    observer(event)
  } catch {
  }
}
