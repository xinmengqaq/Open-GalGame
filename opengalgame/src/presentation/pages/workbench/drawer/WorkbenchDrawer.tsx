import { clsx } from 'clsx'
import { X } from 'lucide-react'
import { useCallback, useEffect, useRef, type ReactElement, type ReactNode } from 'react'
import { toast } from 'sonner'

import type { ProjectVersioningClient } from '@interfaces/project-versioning/client/ProjectVersioningClient'
import type { SceneGenerationClient } from '@interfaces/scene-generation/client/SceneGenerationClient'
import type { ScenePreviewClient } from '@interfaces/scene-preview/client/ScenePreviewClient'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle
} from '@presentation/components/ui/sheet'
import { setGuideTopLayerHost } from '@presentation/features/beginner-guide/guideTopLayer'
import type { SessionSnapshot } from '@presentation/features/workbench-session/workbenchSession.types'
import theme from '../workbenchTheme.module.css'
import { useCandidatePreviewTab } from './candidate/candidatePreviewContext'
import { candidateTabBadgeOf, type CandidatePreviewTarget } from './candidate/candidatePreviewState'
import { CandidatePreviewProvider } from './candidate/CandidatePreviewProvider'
import { CandidatePreviewTab } from './candidate/CandidatePreviewTab'
import { DrawerTabBar } from './DrawerTabBar'
import { drawerTabDomId, drawerTabViewId } from './drawerTabs'
import { SparkleMark } from './drawerIcons'
import { useDrawerMotion } from './useDrawerMotion'
import { VersionHistoryPanel } from './version-history/VersionHistoryPanel'
import type {
  DrawerTabId,
  DrawerTabTone,
  DrawerTabsState,
  WorkbenchDrawerBusy
} from './workbenchDrawer.types'
import './drawer.css'

const BUSY_TOAST_ID = 'workbench-drawer-busy'

interface WorkbenchDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  tabs: DrawerTabsState
  currentTone: DrawerTabTone | null
  worksBusy: WorkbenchDrawerBusy
  onOpenTab: (tab: DrawerTabId) => void
  onActivateTab: (tab: DrawerTabId) => void
  onCloseTab: (tab: DrawerTabId, options?: { worksBusy?: boolean }) => void
  onMoveTab: (tab: DrawerTabId, toIndex: number) => void
  projectId: string
  projectName: string
  versioningClient: ProjectVersioningClient
  generationClient: SceneGenerationClient
  candidatePreviewClient: ScenePreviewClient
  candidateTarget: CandidatePreviewTarget | null
  onCandidateOpened?: (candidateSnapshotId: string) => void
  onCandidateReturned?: (candidateSnapshotId: string) => void
  writeBlockedReason: string | null
  hasUnsavedEdits: boolean
  captureDraft: () => Promise<SessionSnapshot | null>
  onUndoCommitted: (draft: SessionSnapshot | null) => Promise<void>
  onWorksBusyChange: (busy: WorkbenchDrawerBusy) => void
  currentView: ReactNode
  summaryView: ReactNode
  historyView: ReactNode
}

export function WorkbenchDrawer({
  open,
  onOpenChange,
  tabs,
  currentTone,
  worksBusy,
  onOpenTab,
  onActivateTab,
  onCloseTab,
  onMoveTab,
  projectId,
  projectName,
  versioningClient,
  generationClient,
  candidatePreviewClient,
  candidateTarget,
  onCandidateOpened,
  onCandidateReturned,
  writeBlockedReason,
  hasUnsavedEdits,
  captureDraft,
  onUndoCommitted,
  onWorksBusyChange,
  currentView,
  summaryView,
  historyView
}: WorkbenchDrawerProps): ReactElement {
  const root = useRef<HTMLDivElement>(null)
  const busy = worksBusy !== null

  useDrawerMotion(root, { tab: tabs.active })

  // 原生 <dialog> 是浏览器顶层模态。它打开时 Escape 只应关闭该弹窗；
  // 在 window 捕获阶段截住，避免 Radix 的 document 监听同时收起抽屉。
  useEffect(() => {
    if (!open) return
    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (document.querySelector('dialog[open]')) event.stopPropagation()
    }
    window.addEventListener('keydown', handleEscape, true)
    return () => window.removeEventListener('keydown', handleEscape, true)
  }, [open])

  useEffect(() => {
    if (worksBusy === null) {
      toast.dismiss(BUSY_TOAST_ID)
      return
    }
    toast.loading(worksBusy === 'undo' ? '正在撤销这次操作' : '正在清理历史记录', {
      id: BUSY_TOAST_ID,
      description: '完成后才能关闭抽屉或关闭作品历史标签。',
      duration: Infinity
    })
    return () => {
      toast.dismiss(BUSY_TOAST_ID)
    }
  }, [worksBusy])

  const showNotice = useCallback((message: string) => {
    toast(message)
  }, [])

  const requestClose = useCallback(() => {
    if (worksBusy !== null) {
      showNotice(
        worksBusy === 'undo'
          ? '正在撤销这次操作，完成后才能关闭抽屉。'
          : '正在清理历史记录，完成后才能关闭抽屉。'
      )
      return
    }
    onOpenChange(false)
  }, [onOpenChange, showNotice, worksBusy])

  const handleOpenChange = (next: boolean): void => {
    if (next) {
      onOpenChange(true)
      return
    }
    requestClose()
  }

  const handleCloseTab = useCallback(
    (tab: DrawerTabId): void => {
      onCloseTab(tab, { worksBusy: worksBusy !== null })
    },
    [onCloseTab, worksBusy]
  )

  const renderView = (tab: DrawerTabId, content: ReactNode): ReactElement => {
    const active = tabs.active === tab
    return (
      <div
        aria-labelledby={drawerTabDomId(tab)}
        className="wb-drawer__view"
        data-state={active ? 'active' : 'inactive'}
        hidden={!active}
        id={drawerTabViewId(tab)}
        key={tab}
        role="tabpanel"
        tabIndex={0}
      >
        <div className="wb-drawer__view-inner" data-drawer-motion="view">
          {content}
        </div>
      </div>
    )
  }

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        className={clsx('wb-drawer', 'drawer-surface', theme.theme)}
        onEscapeKeyDown={(event) => {
          if (busy) {
            event.preventDefault()
            requestClose()
          }
        }}
        onInteractOutside={(event) => {
          if (busy) event.preventDefault()
        }}
        onPointerDownOutside={(event) => {
          if (busy) {
            event.preventDefault()
            requestClose()
          }
        }}
        showCloseButton={false}
        side="right"
      >
        <SheetTitle className="wb-drawer__sr">创作抽屉</SheetTitle>
        <SheetDescription className="wb-drawer__sr">
          当前场景的生成对话、输入摘要、AI 历史、只读游戏候选与工程级作品保存时间线。
        </SheetDescription>

        <CandidatePreviewProvider
          active={tabs.active === 'candidate'}
          generationClient={generationClient}
          onActivate={() => onOpenTab('candidate')}
          onCandidateOpened={onCandidateOpened}
          onCandidateReturned={onCandidateReturned}
          previewClient={candidatePreviewClient}
          target={candidateTarget}
        >
          <div className="wb-drawer__frame" ref={root}>
            <header className="wb-drawer__header" data-drawer-motion="header">
              <div className="wb-drawer__bar">
                <div className="wb-drawer__brand">
                  <SparkleMark />
                  <span>创作抽屉</span>
                </div>
                <DrawerTabBarSlot
                  activeId={tabs.active}
                  candidateAvailable={tabs.candidateAvailable === true}
                  currentTone={currentTone}
                  onActivate={onActivateTab}
                  onClose={handleCloseTab}
                  onMove={onMoveTab}
                  onOpenView={onOpenTab}
                  tabs={tabs.open}
                  worksBusy={busy}
                />
                <button
                  aria-label="关闭"
                  className="wb-drawer__close"
                  disabled={busy}
                  onClick={requestClose}
                  title={busy ? '正在处理历史操作，完成后可关闭' : '关闭抽屉'}
                  type="button"
                >
                  <X />
                </button>
              </div>
            </header>

            <div className="wb-drawer__body">
              {renderView('current', currentView)}
              {tabs.open.includes('summary') ? renderView('summary', summaryView) : null}
              {tabs.open.includes('history') ? renderView('history', historyView) : null}
              {tabs.open.includes('candidate')
                ? renderView('candidate', <CandidatePreviewTab />)
                : null}
              {tabs.open.includes('works')
                ? renderView(
                    'works',
                    <VersionHistoryPanel
                      captureDraft={captureDraft}
                      client={versioningClient}
                      hasUnsavedEdits={hasUnsavedEdits}
                      onBusyChange={onWorksBusyChange}
                      onOpenAi={() => onOpenTab('current')}
                      onUndoCommitted={onUndoCommitted}
                      projectId={projectId}
                      projectName={projectName}
                      writeBlockedReason={writeBlockedReason}
                    />
                  )
                : null}
            </div>
          </div>
        </CandidatePreviewProvider>
        {/* 新手教程 portal 的同级槽位：教程因此留在对话框内容、
            焦点陷阱与可访问树内，而绘制层级仍高于抽屉表面。 */}
        <div
          ref={setGuideTopLayerHost}
          className="wb-drawer__guide-layer"
          data-guide-top-layer-host=""
        />
      </SheetContent>
    </Sheet>
  )
}

function DrawerTabBarSlot({
  tabs,
  activeId,
  candidateAvailable,
  currentTone,
  worksBusy,
  onActivate,
  onClose,
  onMove,
  onOpenView
}: {
  tabs: readonly DrawerTabId[]
  activeId: DrawerTabId
  candidateAvailable: boolean
  currentTone: DrawerTabTone | null
  worksBusy: boolean
  onActivate: (tab: DrawerTabId) => void
  onClose: (tab: DrawerTabId) => void
  onMove: (tab: DrawerTabId, toIndex: number) => void
  onOpenView: (tab: DrawerTabId) => void
}): ReactElement {
  const candidate = useCandidatePreviewTab()
  return (
    <DrawerTabBar
      activeId={activeId}
      candidateAvailable={candidateAvailable}
      candidateBadge={candidate ? candidateTabBadgeOf(candidate.state) : null}
      currentTone={currentTone}
      onActivate={onActivate}
      onClose={onClose}
      onOpenView={onOpenView}
      onReorder={onMove}
      tabs={tabs}
      worksBusy={worksBusy}
    />
  )
}
