import type { AgentExecution } from './AgentExecution'

export interface Agent<Input, Output> {
  invoke(input: Input, execution: AgentExecution): Promise<Output>
}
