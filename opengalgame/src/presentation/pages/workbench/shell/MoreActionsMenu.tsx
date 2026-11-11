import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement
} from 'react'

import { ChevronDownIcon, MoreIcon } from '../WorkbenchIcons'
import { useMoreActionsMenuMotion } from './useMoreActionsMenuMotion'
import type { WorkbenchToolbarAction } from './workbenchActions'
import styles from './workbenchShell.module.css'

interface MoreActionsMenuProps {
  actions: readonly WorkbenchToolbarAction[]
}

/** 紧凑区的唯一动作入口：只转发注册表里的动作，不复制业务实现。 */
export function MoreActionsMenu({ actions }: MoreActionsMenuProps): ReactElement | null {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])
  const returnFocusRef = useRef(false)
  const initialFocusRef = useRef<'first' | 'last'>('first')
  const menuId = useId()
  const triggerId = useId()
  const { rendered } = useMoreActionsMenuMotion(panelRef, open)

  const closeWithFocus = useCallback(() => {
    returnFocusRef.current = true
    setOpen(false)
  }, [])

  const closeWithoutFocus = useCallback(() => {
    returnFocusRef.current = false
    setOpen(false)
  }, [])

  const openMenu = useCallback((focus: 'first' | 'last') => {
    initialFocusRef.current = focus
    setOpen(true)
  }, [])

  const enabledItems = useCallback(
    () =>
      itemRefs.current.filter((item): item is HTMLButtonElement => item !== null && !item.disabled),
    []
  )

  useEffect(() => {
    if (!open || !rendered) return
    const frame = window.requestAnimationFrame(() => {
      const items = enabledItems()
      const item = initialFocusRef.current === 'last' ? items[items.length - 1] : items[0]
      item?.focus({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [enabledItems, open, rendered])

  useEffect(() => {
    if (rendered || !returnFocusRef.current) return
    returnFocusRef.current = false
    const active = document.activeElement
    const focusMovedToLayer =
      active instanceof HTMLElement && Boolean(active.closest('dialog[open]'))
    if (!focusMovedToLayer) triggerRef.current?.focus({ preventScroll: true })
  }, [rendered])

  useEffect(() => {
    if (!open) return

    function onPointerDown(event: PointerEvent): void {
      const target = event.target
      if (!(target instanceof Node)) return
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return
      closeWithoutFocus()
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      closeWithFocus()
    }

    function onViewportChange(): void {
      closeWithoutFocus()
    }

    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', onViewportChange)
    window.addEventListener('scroll', onViewportChange, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', onViewportChange)
      window.removeEventListener('scroll', onViewportChange, true)
    }
  }, [closeWithFocus, closeWithoutFocus, open])

  function onTriggerKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>): void {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      openMenu('first')
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      openMenu('last')
    } else if (event.key === 'Escape' && open) {
      event.preventDefault()
      closeWithFocus()
    }
  }

  function onItemKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>): void {
    const items = enabledItems()
    if (items.length === 0) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      const current = items.indexOf(event.currentTarget)
      const next = items[(current + direction + items.length) % items.length]
      next?.focus({ preventScroll: true })
      return
    }
    if (event.key === 'Home') {
      event.preventDefault()
      items[0]?.focus({ preventScroll: true })
      return
    }
    if (event.key === 'End') {
      event.preventDefault()
      items[items.length - 1]?.focus({ preventScroll: true })
      return
    }
    if (event.key === 'Tab') {
      event.preventDefault()
      closeWithFocus()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeWithFocus()
    }
  }

  if (actions.length === 0) return null

  return (
    <div className={styles.moreWrap}>
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        className={styles.moreTrigger}
        data-open={open}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label="更多全局动作"
        title="更多全局动作"
        onClick={() => (open ? closeWithFocus() : openMenu('first'))}
        onKeyDown={onTriggerKeyDown}
      >
        <span className={styles.moreIcon}>
          <MoreIcon />
        </span>
        <span className={styles.moreLabel}>更多</span>
        <ChevronDownIcon className={styles.moreChevron} />
      </button>
      {rendered ? (
        <div
          ref={panelRef}
          id={menuId}
          role="menu"
          aria-labelledby={triggerId}
          className={styles.menu}
          inert={!open}
        >
          <p className={styles.menuCaption}>全局动作</p>
          {actions.map((action, index) => (
            <button
              key={action.id}
              ref={(node) => {
                itemRefs.current[index] = node
              }}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={styles.menuItem}
              data-action={action.id}
              disabled={action.disabled}
              onClick={() => {
                action.onInvoke()
                closeWithFocus()
              }}
              onKeyDown={onItemKeyDown}
            >
              <span className={styles.menuIcon}>{action.icon}</span>
              <span className={styles.menuCopy}>
                <span className={styles.menuLabel}>{action.label}</span>
                {action.hint ? <span className={styles.menuHint}>{action.hint}</span> : null}
              </span>
              {action.disabled ? <span className={styles.menuUnavailable}>暂不可用</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
