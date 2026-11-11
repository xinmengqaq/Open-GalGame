import { z } from 'zod'

import type { ExternalContentStore } from '../context/FileContextContentStore'
import type { ExecutionBudget } from '../execution/ExecutionBudget'
import type { AgentProgressObserver } from '../execution/AgentProgress'
import type { AgentExecutionMode, WorkspaceBinding } from './AgentExecution'

/**
 * 生命周期钩子和工具从原生运行时上下文读取的公共字段。
 * 只声明字段名称，取值是否合法由各自的读取函数判断；对象本身按引用传递，不复制也不改写到图状态。
 * 生命周期中间件缺少这份声明时，库传给钩子的上下文是空的。
 */
export const agentRunContextSchema = z.object({
  budget: z.custom<ExecutionBudget>().optional(),
  workspace: z.custom<WorkspaceBinding>().optional(),
  contentStore: z.custom<ExternalContentStore>().optional(),
  requiredMessageIds: z.custom<readonly string[]>().optional(),
  progress: z.custom<AgentProgressObserver>().optional(),
  executionMode: z.custom<AgentExecutionMode>().optional(),
  writtenFiles: z.custom<readonly string[]>().optional()
})
