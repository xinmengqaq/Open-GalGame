import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint'

import type { Agent } from '../agents/Agent'
import type { AgentImplementation } from '../agents/AgentDefinition'
import type {
  AgentExecutionOverride,
  AgentUserExecutionPreference
} from '../config/agentExecutionConfig'
import type { ChatModelCreationRequest } from '../models/LangChainModelFactory'

export interface AgentCreationRequest {
  user?: AgentUserExecutionPreference
  override?: AgentExecutionOverride
  checkpointer?: BaseCheckpointSaver
  model?: ChatModelCreationRequest
}

export interface AgentFactory {
  /**
   * 按实现类的创建定义装配模型、提示词、工具和中间件。
   * 创建阶段不发起模型请求，也不调用文件工具。
   * @param request - 本次覆盖、用户级参数、模型覆盖和可选检查点。
   * @returns 可直接按本次输入和执行上下文调用的实例。
   * @throws {AppException} 标识、提示词、配置或模型设置无效。
   */
  create<Input, Output>(
    implementation: AgentImplementation<Input, Output>,
    request?: AgentCreationRequest
  ): Promise<Agent<Input, Output>>
}
