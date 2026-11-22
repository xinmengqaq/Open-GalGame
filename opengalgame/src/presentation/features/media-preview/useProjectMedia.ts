import { useCallback, useContext, useSyncExternalStore } from 'react'

import { ProjectMediaContext, type ProjectMediaPreviewState } from './mediaContext'

const IDLE: ProjectMediaPreviewState = { status: 'idle' }
const LOADING: ProjectMediaPreviewState = { status: 'loading' }

export function useProjectMedia(
  sourceId: string,
  options: { enabled?: boolean; generation?: string } = {}
): ProjectMediaPreviewState {
  const context = useContext(ProjectMediaContext)
  const enabled = options.enabled ?? true
  const generation = options.generation ?? ''

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!context || !enabled || sourceId.length === 0) return () => undefined
      const acquired = context.cache.acquire(sourceId, { generation, onChange: onStoreChange })
      return acquired.release
    },
    [context, enabled, generation, sourceId]
  )

  const snapshot = useCallback(() => {
    if (!context || !enabled || sourceId.length === 0 || context.projectId.length === 0) {
      return IDLE
    }
    return context.cache.peek(sourceId, { generation }) ?? LOADING
  }, [context, enabled, generation, sourceId])

  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
