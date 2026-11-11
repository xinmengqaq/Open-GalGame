import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

import type { ClearVersionHistoryDTO } from '@application/project-versioning/dto/ProjectVersioningDTO'
import type { VersionHistoryEntryVO } from '@application/project-versioning/vo/VersionHistoryVO'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { ProjectVersioningClient } from '@interfaces/project-versioning/client/ProjectVersioningClient'
import type { FailureState } from '@presentation/feedback/failure'
import type { SessionSnapshot } from '@presentation/features/workbench-session/workbenchSession.types'
import {
  groupHistory,
  historyFeedback,
  historyResultMessage,
  isConflictFailure,
  isUnverifiedFailure,
  removeClearedEntries,
  type HistoryActionFailure,
  type HistoryActionResult,
  type HistoryFilter,
  type HistoryListItem
} from './versionHistoryPresentation'

const PAGE_SIZE = 20

type HistoryStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'failed'
type HistoryBusy = 'undo' | 'clear' | null

type UseVersionHistoryOptions = {
  client: ProjectVersioningClient
  projectId: string
  writeBlockedReason: string | null
  captureDraft: () => Promise<SessionSnapshot | null>
  onUndoCommitted: (draft: SessionSnapshot | null) => Promise<void>
  onBusyChange?: (busy: boolean) => void
}

type UseVersionHistoryResult = {
  filter: HistoryFilter
  setFilter: (filter: HistoryFilter) => void
  entries: readonly VersionHistoryEntryVO[]
  items: readonly HistoryListItem[]
  status: HistoryStatus
  error: FailureState | null
  reloadError: FailureState | null
  moreError: FailureState | null
  nextCursor: string | null
  loadingMore: boolean
  busy: HistoryBusy
  canWrite: boolean
  writeBlockedReason: string | null
  selectedId: string | null
  selectedEntry: VersionHistoryEntryVO | null
  actionFailure: HistoryActionFailure | null
  resetToken: number
  selectEntry: (historyId: string | null) => void
  reload: () => void
  loadMore: () => Promise<void>
  undo: (entry: VersionHistoryEntryVO) => Promise<boolean>
  clear: (selection: ClearVersionHistoryDTO['selection']) => Promise<number | null>
  dismissActionFailure: () => void
}

/**
 * 历史抽屉的查询与写操作。响应按工程和筛选查询代际隔离，
 * 写成功后重新读取第一页；列表内容不视为永久缓存。
 */
export function useVersionHistory({
  client,
  projectId,
  writeBlockedReason,
  captureDraft,
  onUndoCommitted,
  onBusyChange
}: UseVersionHistoryOptions): UseVersionHistoryResult {
  const [filter, setFilterState] = useState<HistoryFilter>('all')
  const [entries, setEntries] = useState<readonly VersionHistoryEntryVO[]>([])
  const [status, setStatus] = useState<HistoryStatus>('loading')
  const [error, setError] = useState<FailureState | null>(null)
  const [reloadError, setReloadError] = useState<FailureState | null>(null)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState<FailureState | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [busy, setBusy] = useState<HistoryBusy>(null)
  const [actionFailure, setActionFailure] = useState<HistoryActionFailure | null>(null)
  const [resetToken, setResetToken] = useState(0)
  const requestGeneration = useRef(0)
  const projectRef = useRef(projectId)
  const entriesRef = useRef(entries)
  const actionInFlight = useRef(false)
  const loadingMoreRef = useRef(false)
  const started = useRef(false)

  useEffect(() => {
    projectRef.current = projectId
  }, [projectId])

  useEffect(() => {
    entriesRef.current = entries
  }, [entries])

  const loadFirstPage = useCallback(
    async (nextFilter: HistoryFilter = filter): Promise<void> => {
      const generation = ++requestGeneration.current
      if (entriesRef.current.length === 0) setStatus('loading')
      setError(null)
      setReloadError(null)
      try {
        const result = await client.listHistory({
          projectId,
          saveMode: nextFilter === 'all' ? undefined : nextFilter,
          pageSize: PAGE_SIZE
        })
        if (generation !== requestGeneration.current) return
        if (result.code !== ErrorCodes.success || result.data === undefined) {
          const failure = { code: result.code, msg: result.msg }
          if (projectRef.current !== projectId) return
          if (entriesRef.current.length > 0) {
            setReloadError(failure)
          } else {
            setStatus('failed')
            setError(failure)
          }
          return
        }
        const page = result.data
        setEntries(page.entries)
        setNextCursor(page.nextCursor)
        setStatus(page.entries.length === 0 ? 'empty' : 'ready')
        setSelectedId((current) =>
          current !== null && page.entries.some((entry) => entry.historyId === current)
            ? current
            : null
        )
      } catch {
        if (generation !== requestGeneration.current) return
        const failure = { code: ErrorCodes.internalError, msg: historyFeedback.loadFailed }
        if (entriesRef.current.length > 0) setReloadError(failure)
        else {
          setStatus('failed')
          setError(failure)
        }
      }
    },
    [client, filter, projectId]
  )

  useEffect(() => {
    if (started.current) return
    started.current = true
    void loadFirstPage()
  }, [loadFirstPage])

  const setFilter = useCallback(
    (next: HistoryFilter) => {
      if (next === filter) return
      requestGeneration.current += 1
      setFilterState(next)
      setSelectedId(null)
      setEntries([])
      setNextCursor(null)
      setMoreError(null)
      setActionFailure(null)
      setError(null)
      setReloadError(null)
      setStatus('loading')
      setResetToken((token) => token + 1)
      void loadFirstPage(next)
    },
    [filter, loadFirstPage]
  )

  const selectEntry = useCallback((historyId: string | null) => {
    setSelectedId(historyId)
    setActionFailure(null)
  }, [])

  const loadMore = useCallback(async (): Promise<void> => {
    if (nextCursor === null || loadingMoreRef.current) return
    loadingMoreRef.current = true
    const generation = requestGeneration.current
    setLoadingMore(true)
    setMoreError(null)
    try {
      const result = await client.listHistory({
        projectId,
        saveMode: filter === 'all' ? undefined : filter,
        cursor: nextCursor,
        pageSize: PAGE_SIZE
      })
      if (generation !== requestGeneration.current || projectRef.current !== projectId) return
      if (result.code !== ErrorCodes.success || result.data === undefined) {
        setMoreError({ code: result.code, msg: result.msg })
        return
      }
      const page = result.data
      setEntries((current) => {
        const seen = new Set(current.map((entry) => entry.historyId))
        return [...current, ...page.entries.filter((entry) => !seen.has(entry.historyId))]
      })
      setNextCursor(page.nextCursor)
    } catch {
      if (generation !== requestGeneration.current) return
      setMoreError({ code: ErrorCodes.internalError, msg: historyFeedback.moreFailed })
    } finally {
      loadingMoreRef.current = false
      if (generation === requestGeneration.current) setLoadingMore(false)
    }
  }, [client, filter, nextCursor, projectId])

  const undo = useCallback(
    async (entry: VersionHistoryEntryVO): Promise<boolean> => {
      if (actionInFlight.current || writeBlockedReason !== null) return false
      actionInFlight.current = true
      onBusyChange?.(true)
      const targetProject = projectId
      setBusy('undo')
      setActionFailure(null)
      let draft: SessionSnapshot | null = null
      try {
        try {
          draft = await captureDraft()
        } catch {
          if (projectRef.current === targetProject) {
            setActionFailure({
              kind: 'undo',
              msg: historyFeedback.draftFailed,
              conflict: false,
              unverified: false
            })
          }
          return false
        }
        const result = await client.undoHistoryEntry({
          projectId: targetProject,
          historyId: entry.historyId
        })
        if (projectRef.current !== targetProject) return false
        if (result.code !== ErrorCodes.success || result.data === undefined) {
          setActionFailure({
            kind: 'undo',
            msg: isConflictFailure(result.code)
              ? historyFeedback.undoConflict
              : isUnverifiedFailure(result.code)
                ? historyFeedback.undoUnverified
                : result.msg || historyFeedback.undoFailed,
            conflict: isConflictFailure(result.code),
            unverified: isUnverifiedFailure(result.code)
          })
          return false
        }
        setEntries((current) =>
          current.map((item) =>
            item.historyId === entry.historyId ? { ...item, state: '已回退', canUndo: false } : item
          )
        )
        const nextResult: HistoryActionResult = {
          kind: 'undo',
          count: 1,
          detail: entry.title
        }
        toast(historyResultMessage(nextResult))
        void onUndoCommitted(draft)
        void loadFirstPage()
        return true
      } catch {
        if (projectRef.current !== targetProject) return false
        setActionFailure({
          kind: 'undo',
          msg: historyFeedback.undoUnverified,
          conflict: false,
          unverified: true
        })
        return false
      } finally {
        actionInFlight.current = false
        setBusy(null)
        onBusyChange?.(false)
      }
    },
    [
      captureDraft,
      client,
      loadFirstPage,
      onBusyChange,
      onUndoCommitted,
      projectId,
      writeBlockedReason
    ]
  )

  const clear = useCallback(
    async (selection: ClearVersionHistoryDTO['selection']): Promise<number | null> => {
      if (actionInFlight.current || writeBlockedReason !== null) return null
      actionInFlight.current = true
      onBusyChange?.(true)
      const targetProject = projectId
      setBusy('clear')
      setActionFailure(null)
      try {
        const result = await client.clearHistory({ projectId: targetProject, selection })
        if (projectRef.current !== targetProject) return null
        if (result.code !== ErrorCodes.success || result.data === undefined) {
          setActionFailure({
            kind: 'clear',
            msg: result.msg || historyFeedback.clearFailed,
            conflict: false,
            unverified: false
          })
          return null
        }
        const clearedCount = result.data.clearedCount
        const boundaryId =
          selection.kind === 'entry' ? selection.historyId : selection.throughHistoryId
        const boundary = entriesRef.current.find((item) => item.historyId === boundaryId)
        const nextResult: HistoryActionResult = {
          kind: 'clear',
          count: clearedCount,
          detail:
            selection.kind === 'entry'
              ? (boundary?.title ?? '单条记录')
              : historyFeedback.clearCategoryDetail(selection.saveMode)
        }
        setEntries((current) => removeClearedEntries(current, selection))
        setSelectedId(null)
        setNextCursor(null)
        toast(historyResultMessage(nextResult))
        setResetToken((token) => token + 1)
        void loadFirstPage()
        return clearedCount
      } catch {
        if (projectRef.current !== targetProject) return null
        setActionFailure({
          kind: 'clear',
          msg: historyFeedback.clearFailed,
          conflict: false,
          unverified: false
        })
        return null
      } finally {
        actionInFlight.current = false
        setBusy(null)
        onBusyChange?.(false)
      }
    },
    [client, loadFirstPage, onBusyChange, projectId, writeBlockedReason]
  )

  const selectedEntry = useMemo(
    () => entries.find((entry) => entry.historyId === selectedId) ?? null,
    [entries, selectedId]
  )
  const items = useMemo(() => groupHistory(entries), [entries])

  return {
    filter,
    setFilter,
    entries,
    items,
    status,
    error,
    reloadError,
    moreError,
    nextCursor,
    loadingMore,
    busy,
    canWrite: writeBlockedReason === null && busy === null,
    writeBlockedReason,
    selectedId,
    selectedEntry,
    actionFailure,
    resetToken,
    selectEntry,
    reload: () => void loadFirstPage(),
    loadMore,
    undo,
    clear,
    dismissActionFailure: () => setActionFailure(null)
  }
}
