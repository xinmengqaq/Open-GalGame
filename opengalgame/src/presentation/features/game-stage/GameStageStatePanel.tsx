import type { ReactElement, ReactNode } from 'react'

import styles from './GameStageStatePanel.module.css'

export type GameStageStateSurface = 'dark' | 'paper'
export type GameStageStateAccent = 'danger' | 'warning' | 'muted'

interface GameStageStatePanelProps {
  readonly surface: GameStageStateSurface
  readonly accent: GameStageStateAccent
  readonly icon: ReactNode
  readonly title: string
  readonly description: string
  readonly actions?: ReactNode
  readonly note?: ReactNode
  readonly role?: 'alert' | 'status'
}

export function GameStageStatePanel({
  surface,
  accent,
  icon,
  title,
  description,
  actions,
  note,
  role
}: GameStageStatePanelProps): ReactElement {
  return (
    <div
      className={styles.state}
      data-surface={surface}
      data-accent={accent}
      {...(role === undefined ? {} : { role })}
    >
      <span className={styles.orb} aria-hidden="true">
        {icon}
      </span>
      <strong>{title}</strong>
      <p>{description}</p>
      {actions ? <div className={styles.actions}>{actions}</div> : null}
      {note ? <span className={styles.note}>{note}</span> : null}
    </div>
  )
}
