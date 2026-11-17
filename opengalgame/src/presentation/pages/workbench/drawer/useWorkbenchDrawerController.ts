import { useCallback, useEffect, useRef, useState } from 'react'

import type { DrawerTabId, DrawerTabsState } from './drawerTabs'
import { useDrawerTabs } from './useDrawerTabs'
import type { WorkbenchDrawerBusy } from './workbenchDrawer.types'

export interface WorkbenchDrawerCandidateSignal {
  readonly available: boolean
  readonly snapshotId: string | null
  readonly sequence: number | null
}

export interface WorkbenchDrawerControllerOptions {
  readonly scopeKey: string
  readonly candidate: WorkbenchDrawerCandidateSignal
  readonly generationActive: boolean
  readonly onReloadGeneration: () => void
}

export interface WorkbenchDrawerActions {
  readonly openGeneration: () => void
  readonly openWorks: () => void
  readonly openTab: (tab: DrawerTabId) => void
  readonly activateTab: (tab: DrawerTabId) => void
  readonly closeTab: (tab: DrawerTabId, options?: { worksBusy?: boolean }) => void
  readonly moveTab: (tab: DrawerTabId, toIndex: number) => void
  /** 打开试玩预览时直接收起抽屉，不抢回触发按钮焦点。 */
  readonly closeForPreview: () => void
}

export interface WorkbenchDrawerController {
  readonly open: boolean
  readonly tabs: DrawerTabsState
  readonly worksBusy: WorkbenchDrawerBusy
  readonly generationLockVisible: boolean
  readonly actions: WorkbenchDrawerActions
  readonly onOpenChange: (next: boolean) => void
  readonly setWorksBusy: (busy: WorkbenchDrawerBusy) => void
}

/** 工作台抽屉唯一所有者：开关、焦点归还、标签分区、忙碌事实与生成锁可见性。 */
export function useWorkbenchDrawerController(
  options: WorkbenchDrawerControllerOptions
): WorkbenchDrawerController {
  const { scopeKey, candidate, generationActive, onReloadGeneration } = options
  const { available, snapshotId, sequence } = candidate
  const [open, setOpen] = useState(false)
  const [worksBusy, setWorksBusy] = useState<WorkbenchDrawerBusy>(null)
  const trigger = useRef<HTMLElement | null>(null)
  const tabs = useDrawerTabs(scopeKey)

  const syncCandidate = tabs.syncCandidate
  /* 每次生成状态更新都报告候选可用性；新范围第一份报告只建基线。 */
  useEffect(() => {
    syncCandidate(available, snapshotId)
  }, [available, snapshotId, sequence, syncCandidate])

  const onOpenChange = useCallback(
    (next: boolean): void => {
      setOpen(next)
      if (next) {
        onReloadGeneration()
        return
      }
      const element = trigger.current
      trigger.current = null
      if (element) window.setTimeout(() => element.focus({ preventScroll: true }), 0)
    },
    [onReloadGeneration]
  )

  const openGeneration = (): void => {
    trigger.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    tabs.open('current')
    setOpen(true)
    onReloadGeneration()
  }

  const openWorks = (): void => {
    trigger.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    tabs.open('works')
    setOpen(true)
  }

  const closeForPreview = useCallback((): void => {
    trigger.current = null
    setOpen(false)
  }, [])

  return {
    open,
    tabs: tabs.state,
    worksBusy,
    generationLockVisible: generationActive && !open,
    actions: {
      openGeneration,
      openWorks,
      openTab: tabs.open,
      activateTab: tabs.activate,
      closeTab: tabs.close,
      moveTab: tabs.move,
      closeForPreview
    },
    onOpenChange,
    setWorksBusy
  }
}
