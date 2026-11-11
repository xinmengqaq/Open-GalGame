import { createContext } from 'react'

import type { ProjectMediaCache, ProjectMediaView } from './mediaCache'

export type ProjectMediaPreviewState = ProjectMediaView | { status: 'idle' } | { status: 'loading' }

export type ProjectMediaContextValue = {
  cache: ProjectMediaCache
  projectId: string
}

export const ProjectMediaContext = createContext<ProjectMediaContextValue | null>(null)
