import { createContext, useContext } from 'react'

import { getActiveWorkbenchCommands, type WorkbenchCommands } from './workbenchCommands'

export const WorkbenchCommandsContext = createContext<WorkbenchCommands | null>(null)

export function useWorkbenchCommands(): WorkbenchCommands {
  const commands = useContext(WorkbenchCommandsContext) ?? getActiveWorkbenchCommands()
  if (!commands) throw new Error('workbench commands are not mounted')
  return commands
}
