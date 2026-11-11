import { AsyncLocalStorage } from 'node:async_hooks'

import type { InformationGainTracker } from './InformationGainTracker'
import type { BaseMessage } from '@langchain/core/messages'

import type { AgentRunContext } from '../agents/AgentExecution'
import type { createAgentStreamConsumer } from '../streaming/AgentStreamConsumer'
import type { LangChainEventStreamAdapter } from '../streaming/LangChainEventStreamAdapter'

export interface ExecutionScope {
  context?: AgentRunContext
  /** 缺省表示本次模型调用不安装超时。 */
  requestTimeoutMs?: number
  /** 缺省表示本次工具调用不安装超时。 */
  toolTimeoutMs?: number
  toolResultCharLimit: number
  summaryOutcome: 'idle' | 'succeeded' | 'failed'
  summarySnapshot?: BaseMessage[]
  requiredMessages?: BaseMessage[]
  attemptSignal?: AbortSignal
  /** 本次调用的结构化输出格式。用于识别合法提交，不写入图状态。 */
  responseFormat?: unknown
  informationGain?: InformationGainTracker
  /** 本轮模型响应关联的工具结果。只在全部返回后结算，不写入图状态。 */
  pendingInformationRound?: import('./InformationGainTracker').InformationRoundFact[]
}

export const executionScope = new AsyncLocalStorage<ExecutionScope>()
export const agentInvocationScope = new AsyncLocalStorage<{
  consumer: ReturnType<typeof createAgentStreamConsumer>
  adapter: LangChainEventStreamAdapter
  interrupted: boolean
}>()
