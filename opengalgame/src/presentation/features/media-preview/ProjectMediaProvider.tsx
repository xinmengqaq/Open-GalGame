import { useMemo, type ReactElement, type ReactNode } from 'react'

import type { ProjectFilesClient } from '@interfaces/project-files/client/ProjectFilesClient'
import { ProjectMediaContext } from './mediaContext'
import { createProjectMediaCache } from './mediaCache'

interface ProjectMediaProviderProps {
  client: ProjectFilesClient
  projectId: string
  children: ReactNode
}

/**
 * 工作台内共享一份媒体字节缓存。目录与画布引用同一来源时只读取一次，
 * 最后一份预览卸载后撤销 Blob URL。缓存随工作台卸载，不需要额外释放。
 */
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
