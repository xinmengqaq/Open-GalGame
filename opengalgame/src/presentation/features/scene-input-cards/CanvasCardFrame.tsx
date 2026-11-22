import { clsx } from 'clsx'
import { useRef, type ReactElement, type ReactNode } from 'react'

import { ContentKindIcon } from '../workbench-session/ContentKindIcon'
import { cardIconProps, cardKindLabel } from '../workbench-session/contentKindLabel'
import type { SessionCard } from '../workbench-session/workbenchSession.types'
import styles from './CanvasCardFrame.module.css'
import { useCardEntranceMotion, useCardFrameMotion } from './useInputCardMotion'

export type CanvasCardLayout = 'card' | 'media' | 'paper'

interface CanvasCardFrameProps {
  card: SessionCard
  selected: boolean
  status?: ReactNode
  children: ReactNode
  actions?: ReactNode
  layout?: CanvasCardLayout
  fill?: boolean
  risk?: boolean
  className?: string
}

export function CanvasCardFrame({
  card,
  selected,
  status,
  children,
  actions,
  layout = 'card',
  fill = false,
  risk = false,
  className
}: CanvasCardFrameProps): ReactElement {
  const root = useRef<HTMLElement>(null)
  const icon = cardIconProps(card)
  useCardEntranceMotion(root)
  useCardFrameMotion(root, selected)

  return (
    <article
      ref={root}
      className={clsx(styles.frame, className)}
      data-kind={card.kind}
      data-card-kind={card.kind}
      data-layout={layout}
      data-selected={selected}
      data-risk={risk || undefined}
      data-fill={fill || undefined}
      data-card-surface="frame"
    >
      {layout !== 'media' ? (
        <span className={styles.selectAura} data-motion="card-seal" aria-hidden="true" />
      ) : null}
      {layout === 'paper' || layout === 'media' ? null : (
        <header className={styles.header}>
          <span className={styles.kind}>
            <span className={styles.kindIcon} aria-hidden="true">
              <ContentKindIcon contentKind={icon.contentKind} textKind={icon.textKind} />
            </span>
            <span className={styles.kindLabel}>{cardKindLabel(card.kind)}</span>
          </span>
          <span className={styles.statusSlot} data-card-status-slot>
            {status}
          </span>
        </header>
      )}
      <div className={styles.content}>{children}</div>
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </article>
  )
}
