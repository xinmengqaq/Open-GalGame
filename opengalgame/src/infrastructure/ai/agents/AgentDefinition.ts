import type { ClientTool, ServerTool } from '@langchain/core/tools'
import type { AnyAgentMiddleware, CreateAgentParams, ReactAgent } from 'langchain'

import type { AgentExecutionOverride } from '../config/agentExecutionConfig'
import type { PromptReference } from '../prompts/PromptReference'
import type { Agent } from './Agent'

export interface AgentDefinition {
  id: string
  prompt: PromptReference
  createTools: () => readonly (ClientTool | ServerTool)[]
  middleware?: readonly AnyAgentMiddleware[]
  responseFormat?: CreateAgentParams['responseFormat']
  stateSchema?: CreateAgentParams['stateSchema']
  contextSchema?: CreateAgentParams['contextSchema']
  execution?: AgentExecutionOverride
}

export interface AgentImplementation<Input, Output> {
  readonly definition: AgentDefinition
  new (executor: ReactAgent): Agent<Input, Output>
}
