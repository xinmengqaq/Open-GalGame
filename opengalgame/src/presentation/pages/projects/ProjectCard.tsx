import { clsx } from 'clsx'
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement
} from 'react'

import { MoreIcon } from '../../components/Icons'
import { ProjectCoverPlaceholder } from './ProjectCoverPlaceholder'
import styles from './ProjectsPage.module.css'
import { useProjectMenuMotion } from './useProjectMenuMotion'
import type { ProjectListEntryVO } from '@application/projects/vo/ProjectVO'

interface ProjectCardProps {
  entry: ProjectListEntryVO
  selected: boolean
  coverSrc?: string
  onSelect: () => void
  onOpen: () => void
  onRename: () => void
  onUnregister: () => void
}

export function ProjectCard({
  entry,
  selected,
  coverSrc,
  onSelect,
  onOpen,
  onRename,
  onUnregister
}: ProjectCardProps): ReactElement {
  const [menuOpen, setMenuOpen] = useState(false)
  const [failedCoverSrc, setFailedCoverSrc] = useState<string | null>(null)
  const cell = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const actions = useRef<HTMLDivElement>(null)
  const returnFocus = useRef(false)
  const initialFocus = useRef<'first' | 'last'>('first')
  const menuId = useId()
  const titleId = useId()
  const { rendered } = useProjectMenuMotion(actions, menuOpen)
  const available = entry.status === 'available'
  const title = available ? entry.name : '无法读取的项目'
  const detail = available ? entry.synopsis : entry.msg
  const showCover = Boolean(coverSrc) && failedCoverSrc !== coverSrc

  useEffect(() => {
    if (!menuOpen || !rendered) return
    const frame = window.requestAnimationFrame(() => {
      const items = actions.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
      if (!items?.length) return
      const item = initialFocus.current === 'last' ? items[items.length - 1] : items[0]
      item.focus({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [menuOpen, rendered])

  useEffect(() => {
    if (rendered || !returnFocus.current) return
    returnFocus.current = false
    trigger.current?.focus({ preventScroll: true })
  }, [rendered])

  useEffect(() => {
    if (!menuOpen) return

    function onPointerDown(event: PointerEvent): void {
      if (event.target instanceof Node && cell.current?.contains(event.target)) return
      returnFocus.current = false
      setMenuOpen(false)
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      returnFocus.current = true
      setMenuOpen(false)
    }

    function onViewportChange(): void {
      returnFocus.current = false
      setMenuOpen(false)
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
  }, [menuOpen])

  function openMenu(focus: 'first' | 'last'): void {
    initialFocus.current = focus
    returnFocus.current = false
    onSelect()
    setMenuOpen(true)
  }

  function closeWithFocus(): void {
    returnFocus.current = true
    setMenuOpen(false)
  }

  function closeWithoutFocus(): void {
    returnFocus.current = false
    setMenuOpen(false)
  }

  function onTriggerKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      openMenu('first')
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      openMenu('last')
      return
    }
    if (event.key === 'Escape' && menuOpen) {
      event.preventDefault()
      closeWithFocus()
    }
  }

  function onItemKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>): void {
    const items = actions.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
    if (!items?.length) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      const index = Array.from(items).indexOf(event.currentTarget)
      items[(index + direction + items.length) % items.length].focus({ preventScroll: true })
      return
    }
    if (event.key === 'Home') {
      event.preventDefault()
      items[0].focus({ preventScroll: true })
      return
    }
    if (event.key === 'End') {
      event.preventDefault()
      items[items.length - 1].focus({ preventScroll: true })
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

  return (
    <div
      ref={cell}
      className={styles.cell}
      data-card-enter
      onBlur={(event) => {
        if (returnFocus.current) return
        const next = event.relatedTarget
        if (next instanceof Node && event.currentTarget.contains(next)) return
        returnFocus.current = false
        setMenuOpen(false)
      }}
    >
      <button
        type="button"
        className={clsx(styles.card, selected && styles.selected, !available && styles.unavailable)}
        data-testid="project-card"
        data-project-id={entry.id}
        data-selected={selected ? 'true' : 'false'}
        onClick={() => {
          if (menuOpen) {
            closeWithoutFocus()
            return
          }
          onSelect()
          if (available) onOpen()
        }}
        onContextMenu={(event) => {
          event.preventDefault()
          openMenu('first')
        }}
      >
        <span className={clsx(styles.coverWrap, !showCover && styles.coverPlaceholderWrap)}>
          {showCover ? (
            <>
              <img
                className={styles.coverImage}
                src={coverSrc}
                alt=""
                onError={() => setFailedCoverSrc(coverSrc ?? null)}
              />
              <span className={styles.coverGlow} aria-hidden="true" />
            </>
          ) : (
            <ProjectCoverPlaceholder />
          )}
        </span>
        <span className={styles.cardCopy}>
          <span id={titleId} className={styles.cardTitle}>
            {title}
          </span>
          <span className={styles.cardSynopsis}>{detail}</span>
        </span>
      </button>
      <button
        ref={trigger}
        type="button"
        className={styles.menuTrigger}
        aria-label="项目操作"
        aria-describedby={titleId}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-controls={menuOpen ? menuId : undefined}
        data-tip="项目操作"
        onClick={() => {
          if (menuOpen) {
            closeWithFocus()
            return
          }
          openMenu('first')
        }}
        onKeyDown={onTriggerKeyDown}
      >
        <MoreIcon className={styles.menuIcon} />
      </button>
      {rendered ? (
        <div
          ref={actions}
          id={menuId}
          className={styles.cardActions}
          role="menu"
          aria-label="项目编辑操作"
          inert={!menuOpen}
        >
          {available ? (
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={styles.cardAction}
              onClick={() => {
                closeWithoutFocus()
                onRename()
              }}
              onKeyDown={onItemKeyDown}
            >
              重命名
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className={`${styles.cardAction} ${styles.cardActionDanger}`}
            onClick={() => {
              closeWithoutFocus()
              onUnregister()
            }}
            onKeyDown={onItemKeyDown}
          >
            移出列表
          </button>
        </div>
      ) : null}
    </div>
  )
}
