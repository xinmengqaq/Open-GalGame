import { clsx } from 'clsx'
import { ArrowLeft, ArrowRight, Plus, X } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode
} from 'react'

import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger
} from '@presentation/components/ui/popover'
import { prefersReducedMotion } from '@presentation/effects/motion'
import {
  DRAWER_TAB_LABEL,
  DRAWER_TAB_TONE_LABEL,
  availableDrawerTabs,
  drawerReorderIndex,
  drawerTabDomId,
  drawerTabViewId,
  isDrawerTabClosable,
  type DrawerTabBadge,
  type DrawerTabId,
  type DrawerTabTone
} from './drawerTabs'
import './drawerTabs.css'

const DRAWER_TAB_HINT: Readonly<Record<Exclude<DrawerTabId, 'current'>, string>> = {
  summary: '本轮输入依据与固定快照',
  history: '当前场景的只读生成记录',
  candidate: '只读游戏画面与读取问题',
  works: '工程级作品保存时间线'
}

export interface DrawerTabBarProps {
  tabs: readonly DrawerTabId[]
  activeId: DrawerTabId
  candidateAvailable: boolean
  candidateBadge?: DrawerTabBadge | null
  currentTone?: DrawerTabTone | null
  worksBusy?: boolean
  onActivate: (tab: DrawerTabId) => void
  onClose: (tab: DrawerTabId) => void
  onReorder: (tab: DrawerTabId, toIndex: number) => void
  onOpenView: (tab: DrawerTabId) => void
}

function toneLabel(tab: DrawerTabId, tone: DrawerTabTone | null): string | null {
  if (tab !== 'current' || tone === null) return null
  return DRAWER_TAB_TONE_LABEL[tone]
}

function tabAriaLabel(
  tab: DrawerTabId,
  tone: DrawerTabTone | null,
  badge: DrawerTabBadge | null
): string {
  const parts = [DRAWER_TAB_LABEL[tab]]
  const toneText = toneLabel(tab, tone)
  if (toneText) parts.push(toneText)
  if (badge && badge.count > 0) parts.push(`${badge.count} 个读取问题`)
  else if (badge?.live) parts.push('正在读取游戏画面')
  return parts.join('，')
}

function focusFirstMenuItem(event: Event): void {
  const target = event.currentTarget
  if (!(target instanceof HTMLElement)) return
  const first = target.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')
  if (!first) return
  event.preventDefault()
  first.focus()
}

function handleMenuKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
  const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End']
  if (!keys.includes(event.key)) return
  const items = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)')
  )
  if (items.length === 0) return
  event.preventDefault()
  const focused = items.findIndex((item) => item === document.activeElement)
  const last = items.length - 1
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? last
        : event.key === 'ArrowDown'
          ? focused < 0
            ? 0
            : (focused + 1) % items.length
          : focused <= 0
            ? last
            : focused - 1
  items[next]?.focus()
}

function MenuList({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className="wb-drawer-tabs__menu-list" onKeyDown={handleMenuKeyDown}>
      {children}
    </div>
  )
}

function AddViewMenu({
  views,
  onOpenView
}: {
  views: readonly DrawerTabId[]
  onOpenView: (tab: DrawerTabId) => void
}): ReactElement {
  const [open, setOpen] = useState(false)

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <button
          aria-haspopup="menu"
          aria-label="打开其他视图"
          className="wb-drawer-tabs__add"
          title="打开其他视图"
          type="button"
        >
          <Plus />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label="未打开的视图"
        className="wb-drawer-tabs__menu"
        collisionPadding={24}
        onOpenAutoFocus={focusFirstMenuItem}
        role="menu"
        side="bottom"
        sideOffset={8}
      >
        <MenuList>
          {views.length === 0 ? (
            <p className="wb-drawer-tabs__menu-empty">所有视图都已打开。</p>
          ) : (
            views.map((view) => (
              <button
                className="wb-drawer-tabs__menu-item"
                key={view}
                onClick={() => {
                  onOpenView(view)
                  setOpen(false)
                }}
                role="menuitem"
                type="button"
              >
                <span className="wb-drawer-tabs__menu-text">
                  <span className="wb-drawer-tabs__menu-label">{DRAWER_TAB_LABEL[view]}</span>
                  <span className="wb-drawer-tabs__menu-hint">{DRAWER_TAB_HINT[view]}</span>
                </span>
              </button>
            ))
          )}
        </MenuList>
      </PopoverContent>
    </Popover>
  )
}

export function DrawerTabBar({
  tabs,
  activeId,
  candidateAvailable,
  candidateBadge = null,
  currentTone = null,
  worksBusy = false,
  onActivate,
  onClose,
  onReorder,
  onOpenView
}: DrawerTabBarProps): ReactElement {
  const listRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef(new Map<DrawerTabId, HTMLButtonElement>())
  const [focusId, setFocusId] = useState<DrawerTabId | null>(null)
  const [dragId, setDragId] = useState<DrawerTabId | null>(null)
  const [dropTarget, setDropTarget] = useState<{
    tab: DrawerTabId
    edge: 'before' | 'after'
  } | null>(null)
  const [menuTab, setMenuTab] = useState<DrawerTabId | null>(null)
  const menuPointerOutsideRef = useRef(false)
  const menuTabRef = useRef<DrawerTabId | null>(null)
  useEffect(() => {
    menuTabRef.current = menuTab
  }, [menuTab])

  const focusTab = useCallback((tab: DrawerTabId) => {
    const node = tabRefs.current.get(tab)
    if (!node) return
    setFocusId(tab)
    node.focus()
  }, [])

  const openMenu = useCallback((tab: DrawerTabId) => {
    menuPointerOutsideRef.current = false
    setMenuTab(tab)
  }, [])

  const handleMenuCloseAutoFocus = useCallback((tab: DrawerTabId, event: Event) => {
    if (menuPointerOutsideRef.current) {
      menuPointerOutsideRef.current = false
      return
    }
    const currentMenu = menuTabRef.current
    if (currentMenu !== null && currentMenu !== tab) return
    event.preventDefault()
    const owner = tabRefs.current.get(tab)
    if (owner?.isConnected) {
      owner.focus()
      return
    }
    listRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus()
  }, [])

  const closeTab = useCallback(
    (tab: DrawerTabId) => {
      const index = tabs.indexOf(tab)
      const neighbor = index > 0 ? tabs[index - 1] : 'current'
      onClose(tab)
      if (neighbor !== tab) focusTab(neighbor)
    },
    [focusTab, onClose, tabs]
  )

  if (menuTab !== null && !tabs.includes(menuTab)) setMenuTab(null)

  const rovingId =
    focusId !== null && tabs.includes(focusId)
      ? focusId
      : tabs.includes(activeId)
        ? activeId
        : (tabs[0] ?? activeId)
  const tabKey = tabs.join('|')

  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>('[data-active="true"]')
    node?.scrollIntoView({
      block: 'nearest',
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      inline: 'nearest'
    })
  }, [activeId, tabKey])

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.target instanceof HTMLElement && event.target.closest('[role="menu"]')) return
    const index = tabs.indexOf(rovingId)
    if (index < 0) return
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      const next = Math.min(
        Math.max(index + (event.key === 'ArrowRight' ? 1 : -1), 0),
        tabs.length - 1
      )
      const tab = tabs[next]
      if (tab) focusTab(tab)
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const tab = event.key === 'Home' ? tabs[0] : tabs[tabs.length - 1]
      if (tab) focusTab(tab)
      return
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      const tab = tabs[index]
      if (!tab || !isDrawerTabClosable(tab, worksBusy)) return
      event.preventDefault()
      closeTab(tab)
    }
  }

  return (
    <div className="wb-drawer-tabs">
      <div
        aria-label="抽屉视图"
        className="wb-drawer-tabs__list"
        onKeyDown={handleKeyDown}
        ref={listRef}
        role="tablist"
      >
        {tabs.map((tab) => {
          const index = tabs.indexOf(tab)
          const active = tab === activeId
          const label = DRAWER_TAB_LABEL[tab]
          const closable = isDrawerTabClosable(tab, worksBusy)
          const showClose = tab !== 'current'
          const tone = tab === 'current' ? currentTone : null
          const badge = tab === 'candidate' ? candidateBadge : null
          const drop = dropTarget?.tab === tab ? dropTarget.edge : null
          const hasMenu = tab !== 'current'
          const menuOpen = hasMenu && menuTab === tab
          const moveBlocked = tab === 'current' || index < 0

          return (
            <Popover
              key={tab}
              onOpenChange={(open) =>
                setMenuTab((current) => (open ? tab : current === tab ? null : current))
              }
              open={menuOpen}
            >
              <PopoverAnchor asChild>
                <div
                  className="wb-drawertab"
                  data-active={active}
                  data-closable={showClose}
                  data-dragging={dragId === tab}
                  data-drop={drop ?? undefined}
                  data-tab={tab}
                  role="presentation"
                  onContextMenu={(event) => {
                    event.preventDefault()
                    if (!hasMenu) return
                    focusTab(tab)
                    openMenu(tab)
                  }}
                  onDragLeave={(event) => {
                    const next = event.relatedTarget
                    if (next instanceof Node && event.currentTarget.contains(next)) return
                    setDropTarget((current) => (current?.tab === tab ? null : current))
                  }}
                  onDragOver={(event) => {
                    if (dragId === null || dragId === tab) return
                    event.preventDefault()
                    event.dataTransfer.dropEffect = 'move'
                    const rect = event.currentTarget.getBoundingClientRect()
                    const edge = event.clientX < rect.left + rect.width / 2 ? 'before' : 'after'
                    setDropTarget((current) =>
                      current?.tab === tab && current.edge === edge ? current : { tab, edge }
                    )
                  }}
                  onDrop={(event) => {
                    if (dragId === null) return
                    event.preventDefault()
                    const edge = dropTarget?.tab === tab ? dropTarget.edge : 'after'
                    const toIndex = drawerReorderIndex(tabs, dragId, tab, edge)
                    if (toIndex !== null) onReorder(dragId, toIndex)
                    setDragId(null)
                    setDropTarget(null)
                  }}
                >
                  <button
                    aria-controls={drawerTabViewId(tab)}
                    aria-expanded={hasMenu ? menuOpen : undefined}
                    aria-haspopup={hasMenu ? 'menu' : undefined}
                    aria-keyshortcuts={
                      hasMenu ? (closable ? 'Delete Shift+F10' : 'Shift+F10') : undefined
                    }
                    aria-label={tabAriaLabel(tab, tone, badge)}
                    aria-selected={active}
                    className="wb-drawertab__button"
                    draggable={!moveBlocked}
                    id={drawerTabDomId(tab)}
                    onClick={() => {
                      focusTab(tab)
                      onActivate(tab)
                    }}
                    onDragEnd={() => {
                      setDragId(null)
                      setDropTarget(null)
                    }}
                    onDragStart={(event: DragEvent<HTMLButtonElement>) => {
                      if (moveBlocked) {
                        event.preventDefault()
                        return
                      }
                      event.dataTransfer.effectAllowed = 'move'
                      event.dataTransfer.setData('text/plain', tab)
                      setMenuTab(null)
                      setDragId(tab)
                    }}
                    onFocus={() => setFocusId(tab)}
                    onKeyDown={(event) => {
                      if (!hasMenu) return
                      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                        event.preventDefault()
                        openMenu(tab)
                      }
                    }}
                    ref={(node) => {
                      if (node) tabRefs.current.set(tab, node)
                      else tabRefs.current.delete(tab)
                    }}
                    role="tab"
                    tabIndex={rovingId === tab ? 0 : -1}
                    title={tone ? `${label} · ${DRAWER_TAB_TONE_LABEL[tone]}` : label}
                    type="button"
                  >
                    {tone ? (
                      <span aria-hidden="true" className="wb-drawertab__tone" data-tone={tone} />
                    ) : null}
                    <span className="wb-drawertab__label">{label}</span>
                    {badge && badge.count > 0 ? (
                      <span className="wb-drawertab__badge">{badge.count}</span>
                    ) : badge?.live ? (
                      <span aria-hidden="true" className="wb-drawertab__live" />
                    ) : null}
                  </button>
                  {showClose ? (
                    <button
                      aria-label={`关闭“${label}”`}
                      className="wb-drawertab__close"
                      disabled={!closable}
                      onClick={() => closeTab(tab)}
                      tabIndex={-1}
                      title={closable ? `关闭“${label}”` : '正在处理历史操作，完成后才能关闭'}
                      type="button"
                    >
                      <X />
                    </button>
                  ) : null}
                </div>
              </PopoverAnchor>
              {hasMenu ? (
                <PopoverContent
                  align="start"
                  aria-label={`${label}标签菜单`}
                  className="wb-drawertab__menu"
                  collisionPadding={24}
                  onCloseAutoFocus={(event) => handleMenuCloseAutoFocus(tab, event)}
                  onOpenAutoFocus={focusFirstMenuItem}
                  onPointerDownOutside={() => {
                    menuPointerOutsideRef.current = true
                  }}
                  role="menu"
                  side="bottom"
                  sideOffset={8}
                >
                  <MenuList>
                    <button
                      className="wb-drawertab__menu-item"
                      disabled={moveBlocked || index <= 1}
                      onClick={() => {
                        onReorder(tab, index - 1)
                        setMenuTab(null)
                      }}
                      role="menuitem"
                      type="button"
                    >
                      <ArrowLeft />
                      左移
                    </button>
                    <button
                      className="wb-drawertab__menu-item"
                      disabled={moveBlocked || index >= tabs.length - 1}
                      onClick={() => {
                        onReorder(tab, index + 1)
                        setMenuTab(null)
                      }}
                      role="menuitem"
                      type="button"
                    >
                      <ArrowRight />
                      右移
                    </button>
                    {showClose ? (
                      <button
                        className={clsx(
                          'wb-drawertab__menu-item',
                          'wb-drawertab__menu-item--danger'
                        )}
                        disabled={!closable}
                        onClick={() => {
                          setMenuTab(null)
                          closeTab(tab)
                        }}
                        role="menuitem"
                        title={closable ? undefined : '正在处理历史操作，完成后才能关闭'}
                        type="button"
                      >
                        <X />
                        关闭
                      </button>
                    ) : null}
                  </MenuList>
                </PopoverContent>
              ) : null}
            </Popover>
          )
        })}
      </div>
      <AddViewMenu
        onOpenView={onOpenView}
        views={availableDrawerTabs(tabs, { candidateAvailable })}
      />
    </div>
  )
}
