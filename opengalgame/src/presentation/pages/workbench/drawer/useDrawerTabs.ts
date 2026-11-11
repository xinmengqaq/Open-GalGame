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

/** 切换工程/场景时重置标签；同一范围内保留顺序和开关。 */
export function drawerTabsSnapshotForScope(
  snapshot: DrawerTabsSnapshot,
  scopeKey: string
): DrawerTabsSnapshot {
  if (snapshot.scope === scopeKey) return snapshot
  return { scope: scopeKey, tabs: createDrawerTabsState() }
}

export interface DrawerTabsController {
  state: DrawerTabsState
  /** 打开或聚焦标签；已打开不会重复创建。 */
  open: (tab: DrawerTabId) => void
  activate: (tab: DrawerTabId) => void
  close: (tab: DrawerTabId, options?: { worksBusy?: boolean }) => void
  /** 拖拽和标签菜单左移/右移共用的重排入口。 */
  move: (tab: DrawerTabId, toIndex: number) => void
  /**
   * 报告当前候选可用性。新范围的第一份报告只建立基线，已有候选不补标签；
   * 之后只有 false→true，或换上一个新的候选快照，才自动加入且不切换。
   */
  syncCandidate: (available: boolean, candidateSnapshotId: string | null) => void
  reset: () => void
}

/**
 * 页面内存里的标签状态。关闭抽屉再打开由同一个 hook 实例恢复；
 * 不写 localStorage，重启应用后从只开“当前生成”开始。
 */
export function useDrawerTabs(scopeKey: string): DrawerTabsController {
  const [snapshot, setSnapshot] = useState<DrawerTabsSnapshot>(() => ({
    scope: scopeKey,
    tabs: createDrawerTabsState()
  }))

  /* 范围变化在当轮渲染就重置，不先显示上一范围的标签再纠正。 */
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
