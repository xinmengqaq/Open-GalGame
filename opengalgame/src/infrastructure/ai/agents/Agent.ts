import type { AgentExecution } from './AgentExecution'

export interface Agent<Input, Output> {
  /**
   * @param execution - 取消信号、运行上下文、身份、状态定位和预算。
   * @throws {AppException} 配置、授权、预算、取消或模型执行失败。
   */
  invoke(input: Input, execution: AgentExecution): Promise<Output>
}
