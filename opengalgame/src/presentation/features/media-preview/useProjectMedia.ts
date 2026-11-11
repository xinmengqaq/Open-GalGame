import { useCallback, useContext, useSyncExternalStore } from 'react'

import { ProjectMediaContext, type ProjectMediaPreviewState } from './mediaContext'

const IDLE: ProjectMediaPreviewState = { status: 'idle' }
const LOADING: ProjectMediaPreviewState = { status: 'loading' }

/**
 * 订阅一个来源的受控媒体字节。同来源共享在途读取和 Blob URL。
 * @param sourceId - 来源身份。空字符串表示没有可读来源。
 * @param options.enabled - 为 false 时不读取（目录行离开视口时使用）。
 * @param options.generation - 重试代数；非空时才另起一次读取。
 */
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
      const acquired = context.cache.acquire(sourceId, generation, onStoreChange)
      return acquired.release
    },
    [context, enabled, generation, sourceId]
  )

  const snapshot = useCallback(() => {
    if (!context || !enabled || sourceId.length === 0 || context.projectId.length === 0) {
      return IDLE
    }
    return context.cache.peek(sourceId, generation) ?? LOADING
  }, [context, enabled, generation, sourceId])

  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
