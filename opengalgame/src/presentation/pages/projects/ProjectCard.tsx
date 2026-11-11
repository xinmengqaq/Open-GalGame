import { clsx } from 'clsx'
import { useEffect, useRef, useState, type ReactElement } from 'react'

import { Button } from '../../components/Button'
import styles from './ProjectsPage.module.css'
import type { ProjectListEntryVO } from '@application/projects/vo/ProjectVO'

interface ProjectCardProps {
  entry: ProjectListEntryVO
  selected: boolean
  coverSrc: string
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
  const cell = useRef<HTMLDivElement>(null)
  const card = useRef<HTMLButtonElement>(null)
  const actions = useRef<HTMLDivElement>(null)
  const showActions = menuOpen && selected
  const available = entry.status === 'available'
  const title = available ? entry.name : '无法读取的项目'
  const detail = available ? entry.synopsis : entry.msg

  useEffect(() => {
    if (!showActions) return
    actions.current?.querySelector('button')?.focus()
    const dismiss = (event: PointerEvent): void => {
      if (!cell.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    const closeOnEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setMenuOpen(false)
      card.current?.focus()
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [showActions])

  return (
    <div
      ref={cell}
      className={styles.cell}
      data-card-enter
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setMenuOpen(false)
      }}
    >
      <button
        ref={card}
        type="button"
        className={clsx(styles.card, selected && styles.selected, !available && styles.unavailable)}
        aria-expanded={showActions}
        data-testid="project-card"
        data-project-id={entry.id}
        onClick={() => {
          setMenuOpen(false)
          if (available) onOpen()
        }}
        onContextMenu={(event) => {
          event.preventDefault()
          onSelect()
          setMenuOpen(true)
        }}
      >
        <span className={styles.coverWrap}>
          <img className={styles.cover} src={coverSrc} alt="" />
        </span>
        <span className={styles.cardTitle}>{title}</span>
        <span className={styles.cardSynopsis}>{detail}</span>
      </button>
      {showActions ? (
        <div ref={actions} className={styles.cardActions} role="group" aria-label="项目编辑操作">
          {available ? (
            <Button
              className={styles.cardAction}
              variant="secondary"
              onClick={() => {
                setMenuOpen(false)
                onRename()
              }}
            >
              重命名
            </Button>
          ) : null}
          <Button
            className={styles.cardAction}
            variant="secondary"
            onClick={() => {
              setMenuOpen(false)
              onUnregister()
            }}
          >
            移出列表
          </Button>
        </div>
      ) : null}
    </div>
  )
}
