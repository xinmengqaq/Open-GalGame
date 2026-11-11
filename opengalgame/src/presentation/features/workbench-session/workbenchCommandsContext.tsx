import { createContext, useContext, useEffect, type ReactElement, type ReactNode } from 'react'

import {
  getActiveWorkbenchCommands,
  setActiveWorkbenchCommands,
  type WorkbenchCommands
} from './workbenchCommands'

const WorkbenchCommandsContext = createContext<WorkbenchCommands | null>(null)

export function WorkbenchCommandsProvider({
  commands,
  children
}: {
  commands: WorkbenchCommands
  children: ReactNode
}): ReactElement {
  useEffect(() => {
    setActiveWorkbenchCommands(commands)
    return () => setActiveWorkbenchCommands(null)
  }, [commands])
  return (
    <WorkbenchCommandsContext.Provider value={commands}>
      {children}
    </WorkbenchCommandsContext.Provider>
  )
}

/** 工作台组件只经这个入口编辑编排，不直接创建客户端。 */
export function useWorkbenchCommands(): WorkbenchCommands {
  const commands = useContext(WorkbenchCommandsContext) ?? getActiveWorkbenchCommands()
  if (!commands) throw new Error('workbench commands are not mounted')
  return commands
}
