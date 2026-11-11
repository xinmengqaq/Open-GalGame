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
  /** 页面级标签状态；关闭抽屉不卸载，同一工程/场景内保留开关与顺序。 */
  tabs: DrawerTabsState
  /** “当前生成”标签的真实状态点。 */
  currentTone: DrawerTabTone | null
  /** 作品历史写操作在途；标签栏、关闭保护和标签模型共用。 */
  worksBusy: WorkbenchDrawerBusy
  onOpenTab: (tab: DrawerTabId) => void
  onActivateTab: (tab: DrawerTabId) => void
  /** 关闭标签时把作品历史忙碌事实一起交给标签模型。 */
  onCloseTab: (tab: DrawerTabId, options?: { worksBusy?: boolean }) => void
  onMoveTab: (tab: DrawerTabId, toIndex: number) => void
  projectId: string
  projectName: string
  versioningClient: ProjectVersioningClient
  generationClient: SceneGenerationClient
  candidatePreviewClient: ScenePreviewClient
  /** 当前生成交互公开的固定候选；为 null 时不出现“游戏候选”标签。 */
  candidateTarget: CandidatePreviewTarget | null
  writeBlockedReason: string | null
  hasUnsavedEdits: boolean
  captureDraft: () => Promise<SessionSnapshot | null>
  onUndoCommitted: (draft: SessionSnapshot | null) => Promise<void>
  onWorksBusyChange: (busy: WorkbenchDrawerBusy) => void
  /** 当前生成视图；头部工程/场景/状态/Token 由生成面板自己显示。 */
  currentView: ReactNode
  /** 输入摘要、AI 历史独立标签内容；由页面按真实状态注入。 */
  summaryView: ReactNode
  historyView: ReactNode
}

/**
 * 工作台唯一的右侧模态抽屉。壳只负责容器、浏览器式标签栏、焦点和关闭保护；
 * 生成、候选与作品历史视图仍由页面注入或现有客户端提供，壳里不创建状态机。
 */
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

  /* 写操作在途时用持久轻提示说明关闭和关闭标签限制，不占用抽屉头部布局。 */
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
      </SheetContent>
    </Sheet>
  )
}

/**
 * 标签栏在候选 Provider 内读取真实读取问题数；候选可用性仍由标签模型决定，
 * 两者分别传，不互相推导。
 */
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
