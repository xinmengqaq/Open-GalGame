import { useEffect, type ReactElement, type ReactNode } from 'react'

import {
  setActiveWorkbenchCommands,
  type WorkbenchCommands
} from './workbenchCommands'
import { WorkbenchCommandsContext } from './workbenchCommandsContext'

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
