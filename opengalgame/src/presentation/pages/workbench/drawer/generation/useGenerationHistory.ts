import { useCallback, useEffect, useRef, useState } from 'react'

import type { SceneGenerationHistorySummaryVO } from '@application/scene-generation/vo/SceneGenerationRenderVO'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { SceneGenerationClient } from '@interfaces/scene-generation/client/SceneGenerationClient'
import {
  historyHasMore,
  historyPageSize,
  historyViewStateOf,
  mergeHistoryPage,
  nextHistoryCursor,
  type HistoryViewState
} from './generationHistoryPresentation'

const loadFailed = 'AI 历史暂时读取失败，请稍后重试。'
const moreFailed = '更早的记录没有读出来，已保留当前列表。'

type UseGenerationHistoryOptions = {
  client: SceneGenerationClient
  projectId: string
  sceneId: string
  refreshKey?: string
}

export type GenerationHistoryController = {
  items: readonly SceneGenerationHistorySummaryVO[]
  view: HistoryViewState
  loading: boolean
  loadingMore: boolean
  error: string | null
  hasMore: boolean
  reload: () => void
  retry: () => void
  loadMore: () => void
}

/**
 * 场景级 AI 历史的分页读取。只使用后端摘要 VO；游标取上一页最后一条
 * `checkpointId`，后端不返回 nextCursor，也不虚构总数。工程或场景变化时清空重读，
 * 读取失败保留已加载条目。
 */
export function useGenerationHistory({
  client,
  projectId,
  sceneId,
  refreshKey
}: UseGenerationHistoryOptions): GenerationHistoryController {
  const [items, setItems] = useState<readonly SceneGenerationHistorySummaryVO[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [cursor, setCursor] = useState<string | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)

  const scope = `${projectId}|${sceneId}`
  const scopeRef = useRef(scope)
  const itemsRef = useRef(items)
  const hasMoreRef = useRef(hasMore)
  const cursorRef = useRef(cursor)
  const loadedScopeRef = useRef('')
  const requestGeneration = useRef(0)
  const loadingMoreRef = useRef(false)

  useEffect(() => {
    scopeRef.current = scope
  }, [scope])

  useEffect(() => {
    itemsRef.current = items
  }, [items])

  useEffect(() => {
    hasMoreRef.current = hasMore
  }, [hasMore])

  useEffect(() => {
    cursorRef.current = cursor
  }, [cursor])

  useEffect(() => {
    const key = `${projectId}|${sceneId}`
    let cancelled = false

    const load = async (): Promise<void> => {
      if (!projectId || !sceneId) {
        requestGeneration.current += 1
        scopeRef.current = key
        loadedScopeRef.current = ''
        itemsRef.current = []
        hasMoreRef.current = false
        cursorRef.current = null
        loadingMoreRef.current = false
        setItems([])
        setHasMore(false)
        setCursor(null)
        setLoadingMore(false)
        setLoading(false)
        setError(null)
        return
      }

      const generation = ++requestGeneration.current
      scopeRef.current = key
      const sameScope = loadedScopeRef.current === key
      setLoading(true)
      setLoadingMore(false)
      loadingMoreRef.current = false
      setError(null)
      if (!sameScope) {
        itemsRef.current = []
        hasMoreRef.current = false
        cursorRef.current = null
        setItems([])
        setHasMore(false)
        setCursor(null)
      }

      try {
        const result = await client.listHistory({ projectId, sceneId, limit: historyPageSize })
        if (cancelled || generation !== requestGeneration.current || scopeRef.current !== key)
          return
        if (result.code !== ErrorCodes.success || result.data === undefined) {
          setLoading(false)
          setError(result.msg || loadFailed)
          return
        }
        const page = result.data
        const merged = mergeHistoryPage([], page, { projectId, sceneId })
        loadedScopeRef.current = key
        itemsRef.current = merged
        hasMoreRef.current = historyHasMore(page.length)
        cursorRef.current = nextHistoryCursor(page)
        setItems(merged)
        setHasMore(historyHasMore(page.length))
        setCursor(nextHistoryCursor(page))
        setLoading(false)
      } catch {
        if (cancelled || generation !== requestGeneration.current) return
        setLoading(false)
        setError(loadFailed)
      }
    }

    void load()

    return () => {
      cancelled = true
    }
  }, [client, projectId, refreshKey, reloadNonce, sceneId])

  const reload = useCallback((): void => {
    setReloadNonce((nonce) => nonce + 1)
  }, [])

  const loadMore = useCallback((): void => {
    const currentCursor = cursorRef.current
    if (loadingMoreRef.current || currentCursor === null || !hasMoreRef.current) return
    const key = scopeRef.current
    const generation = requestGeneration.current
    loadingMoreRef.current = true
    setLoadingMore(true)
    setError(null)
    void (async () => {
      try {
        const result = await client.listHistory({
          projectId,
          sceneId,
          cursor: currentCursor,
          limit: historyPageSize
        })
        if (generation !== requestGeneration.current || scopeRef.current !== key) return
        if (result.code !== ErrorCodes.success || result.data === undefined) {
          setError(result.msg || moreFailed)
          return
        }
        const page = result.data
        const merged = mergeHistoryPage(itemsRef.current, page, { projectId, sceneId })
        itemsRef.current = merged
        hasMoreRef.current = historyHasMore(page.length)
        cursorRef.current = nextHistoryCursor(page)
        setItems(merged)
        setHasMore(historyHasMore(page.length))
        setCursor(nextHistoryCursor(page))
      } catch {
        if (generation !== requestGeneration.current || scopeRef.current !== key) return
        setError(moreFailed)
      } finally {
        loadingMoreRef.current = false
        setLoadingMore(false)
      }
    })()
  }, [client, projectId, sceneId])

  const retry = useCallback((): void => {
    if (items.length > 0 && hasMore) {
      loadMore()
      return
    }
    reload()
  }, [hasMore, items.length, loadMore, reload])

  return {
    items,
    view: historyViewStateOf({ count: items.length, loading, error }),
    loading,
    loadingMore,
    error,
    hasMore,
    reload,
    retry,
    loadMore
  }
}
