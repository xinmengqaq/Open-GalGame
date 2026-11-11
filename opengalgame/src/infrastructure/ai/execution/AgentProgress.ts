import type { ExecutionBudgetUsage } from './ExecutionBudget'

/** 模型或工具边界上的同步活动。回调不得抛错，也不得等待发布。 */
export type AgentProgressEvent = {
  kind: 'model-start' | 'model-end' | 'tool-start' | 'tool-end' | 'completion-nudge'
  at: number
  usage: ExecutionBudgetUsage
  lastToolName?: string
  noNewInformationStreak?: number
}

export type AgentProgressObserver = (event: AgentProgressEvent) => void

/** 观察失败只留在调用边界，不升级为生成失败。 */
export function notifyAgentProgress(
  observer: AgentProgressObserver | undefined,
  event: AgentProgressEvent
): void {
  if (!observer) return
  try {
    observer(event)
  } catch {
    // 进度观察不是生成结果。
  }
}
