import { createContext, useContext } from 'react'

import { getActiveWorkbenchCommands, type WorkbenchCommands } from './workbenchCommands'

export const WorkbenchCommandsContext = createContext<WorkbenchCommands | null>(null)

/** 工作台组件只经这个入口编辑编排，不直接创建客户端。 */
export function useWorkbenchCommands(): WorkbenchCommands {
  const commands = useContext(WorkbenchCommandsContext) ?? getActiveWorkbenchCommands()
  if (!commands) throw new Error('workbench commands are not mounted')
  return commands
}
