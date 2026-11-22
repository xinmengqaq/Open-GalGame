import { useMemo, type ReactElement, type ReactNode } from 'react'

import type { ProjectFilesClient } from '@interfaces/project-files/client/ProjectFilesClient'
import { ProjectMediaContext } from './mediaContext'
import { createProjectMediaCache } from './mediaCache'

interface ProjectMediaProviderProps {
  client: ProjectFilesClient
  projectId: string
  children: ReactNode
}

export function ProjectMediaProvider({
  client,
  projectId,
  children
}: ProjectMediaProviderProps): ReactElement {
  const cache = useMemo(
    () =>
      createProjectMediaCache({
        read: (sourceId) => client.readProjectMedia({ projectId, sourceId })
      }),
    [client, projectId]
  )
  const value = useMemo(() => ({ cache, projectId }), [cache, projectId])
  return <ProjectMediaContext.Provider value={value}>{children}</ProjectMediaContext.Provider>
}
