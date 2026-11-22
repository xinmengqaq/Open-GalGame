import { useCallback, useState } from 'react'

import {
  createDrawerTabsState,
  drawerTabsReducer,
  type DrawerTabId,
  type DrawerTabsAction,
  type DrawerTabsState
} from './drawerTabs'

export interface DrawerTabsSnapshot {
  scope: string
  tabs: DrawerTabsState
}

export function drawerTabsSnapshotForScope(
  snapshot: DrawerTabsSnapshot,
  scopeKey: string
): DrawerTabsSnapshot {
  if (snapshot.scope === scopeKey) return snapshot
  return { scope: scopeKey, tabs: createDrawerTabsState() }
}

export interface DrawerTabsController {
  state: DrawerTabsState
  open: (tab: DrawerTabId) => void
  activate: (tab: DrawerTabId) => void
  close: (tab: DrawerTabId, options?: { worksBusy?: boolean }) => void
  move: (tab: DrawerTabId, toIndex: number) => void
  syncCandidate: (available: boolean, candidateSnapshotId: string | null) => void
  reset: () => void
}

export function useDrawerTabs(scopeKey: string): DrawerTabsController {
  const [snapshot, setSnapshot] = useState<DrawerTabsSnapshot>(() => ({
    scope: scopeKey,
    tabs: createDrawerTabsState()
  }))

  const scoped = drawerTabsSnapshotForScope(snapshot, scopeKey)
  if (scoped !== snapshot) setSnapshot(scoped)

  const dispatch = useCallback(
    (action: DrawerTabsAction) => {
      setSnapshot((previous) => {
        const base = drawerTabsSnapshotForScope(previous, scopeKey)
        return { scope: scopeKey, tabs: drawerTabsReducer(base.tabs, action) }
      })
    },
    [scopeKey]
  )

  const open = useCallback((tab: DrawerTabId) => dispatch({ type: 'open', tab }), [dispatch])
  const activate = useCallback(
    (tab: DrawerTabId) => dispatch({ type: 'activate', tab }),
    [dispatch]
  )
  const close = useCallback(
    (tab: DrawerTabId, options?: { worksBusy?: boolean }) =>
      dispatch({ type: 'close', tab, worksBusy: options?.worksBusy }),
    [dispatch]
  )
  const move = useCallback(
    (tab: DrawerTabId, toIndex: number) => dispatch({ type: 'move', tab, toIndex }),
    [dispatch]
  )
  const syncCandidate = useCallback(
    (available: boolean, candidateSnapshotId: string | null) =>
      dispatch({ type: 'candidate-availability', available, candidateSnapshotId }),
    [dispatch]
  )
  const reset = useCallback(() => dispatch({ type: 'reset' }), [dispatch])

  return {
    state: scoped.tabs,
    open,
    activate,
    close,
    move,
    syncCandidate,
    reset
  }
}
