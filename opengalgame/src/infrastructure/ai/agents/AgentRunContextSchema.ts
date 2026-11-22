import { z } from 'zod'

import type { ExternalContentStore } from '../context/FileContextContentStore'
import type { ExecutionBudget } from '../execution/ExecutionBudget'
import type { AgentProgressObserver } from '../execution/AgentProgress'
import type { AgentExecutionMode, WorkspaceBinding } from './AgentExecution'

export const agentRunContextSchema = z.object({
  budget: z.custom<ExecutionBudget>().optional(),
  workspace: z.custom<WorkspaceBinding>().optional(),
  contentStore: z.custom<ExternalContentStore>().optional(),
  requiredMessageIds: z.custom<readonly string[]>().optional(),
  progress: z.custom<AgentProgressObserver>().optional(),
  executionMode: z.custom<AgentExecutionMode>().optional(),
  writtenFiles: z.custom<readonly string[]>().optional()
})
