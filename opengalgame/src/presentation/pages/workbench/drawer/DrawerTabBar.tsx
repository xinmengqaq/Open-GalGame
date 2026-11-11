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

/** `+` 菜单只解释入口，不重复标签里的状态。 */
const DRAWER_TAB_HINT: Readonly<Record<Exclude<DrawerTabId, 'current'>, string>> = {
  summary: '本轮输入依据与固定快照',
  history: '当前场景的只读生成记录',
  candidate: '只读游戏画面与读取问题',
  works: '工程级作品保存时间线'
}

export interface DrawerTabBarProps {
  /** 已打开标签，`current` 固定在首位。 */
  tabs: readonly DrawerTabId[]
  activeId: DrawerTabId
  /**
   * 当前范围是否存在可打开的固定候选；只决定 `+` 菜单是否列出“游戏候选”，
   * 与读取角标解耦。候选不可用时由标签模型移除已打开标签。
   */
  candidateAvailable: boolean
  /** 候选读取角标；null 表示还没有读取结果，不表示候选不可用。 */
  candidateBadge?: DrawerTabBadge | null
  /** “当前生成”的状态点；null 不显示装饰。 */
  currentTone?: DrawerTabTone | null
  /** 作品历史写操作在途时禁止关闭该标签。 */
  worksBusy?: boolean
  onActivate: (tab: DrawerTabId) => void
  onClose: (tab: DrawerTabId) => void
  /** 标签移动后的最终下标；`current` 固定第一，调用方按同一规则拒绝。 */
  onReorder: (tab: DrawerTabId, toIndex: number) => void
  /** 从 `+` 菜单打开视图；已打开的视图由模型聚焦，不重复创建。 */
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

/** 打开浮层时把焦点交给第一个菜单项，键盘用户不用再按一次 Tab。 */
function focusFirstMenuItem(event: Event): void {
  const target = event.currentTarget
  if (!(target instanceof HTMLElement)) return
  const first = target.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')
  if (!first) return
  event.preventDefault()
  first.focus()
}

/** 菜单内上下键移动焦点；Esc 和外点关闭由 Popover 负责。 */
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

/**
 * 生成抽屉的浏览器式标签栏。受控组件：标签的开关、激活和顺序都由
 * `drawerTabs.ts` 的模型决定，这里只把交互转成回调。
 */
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
  /**
   * 菜单因外点关闭时，焦点应跟随用户点击目标，不能抢回标签。
   * Radix 的非模态 Popover 会在关闭时把焦点交给 trigger，而标签菜单没有
   * `PopoverTrigger`，所以由调用侧接管关闭后的焦点。
   */
  const menuPointerOutsideRef = useRef(false)
  /** 关闭回调在卸载后异步执行，用 ref 读到关闭瞬间是否已换成另一个菜单。 */
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

  /**
   * 非模态 Popover 的内容关闭后异步卸载，焦点可能已被 Radix 焦点域放到
   * dialog 根或 body。Esc、菜单动作和普通关闭都要把焦点交回打开菜单的标签；
   * 只有外点跟随用户点击目标，或另一个菜单已经接管焦点时不抢。
   */
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
    /* 标签已被模型移除时，把焦点交给当前活动标签，不留在 body 或 dialog 根。 */
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

  /* 模型移除标签（如候选不可用）时清掉菜单状态，避免同一 id 重新加入后自动弹出。 */
  if (menuTab !== null && !tabs.includes(menuTab)) setMenuTab(null)

  const rovingId =
    focusId !== null && tabs.includes(focusId)
      ? focusId
      : tabs.includes(activeId)
        ? activeId
        : (tabs[0] ?? activeId)
  const tabKey = tabs.join('|')

  /* 活动标签始终滚入可见区；减少动态效果时直接跳位。 */
  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>('[data-active="true"]')
    node?.scrollIntoView({
      block: 'nearest',
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      inline: 'nearest'
    })
  }, [activeId, tabKey])

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    /* 浮层菜单里的方向键和删除键归菜单自己处理，不移动标签焦点。 */
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
          /* `current` 固定第一、不可关闭也不可移动，没有可执行的标签菜单。 */
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
