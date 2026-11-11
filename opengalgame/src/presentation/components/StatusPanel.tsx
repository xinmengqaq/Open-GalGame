import { clsx } from 'clsx'
import type { ReactElement } from 'react'

import { CheckIcon, ErrorIcon } from './Icons'
import styles from './StatusPanel.module.css'

export type StatusKind = 'info' | 'busy' | 'success' | 'error'

interface StatusPanelProps {
  status: StatusKind
  title: string
  detail?: string
}

export function StatusPanel({ status, title, detail }: StatusPanelProps): ReactElement {
  return (
    <div className={clsx(styles.panel, styles[status])} data-status={status}>
      <span className={styles.icon} aria-hidden="true">
        {status === 'busy' ? <span className={styles.spinner} /> : null}
        {status === 'success' ? <CheckIcon /> : null}
        {status === 'error' ? <ErrorIcon /> : null}
        {status === 'info' ? <CheckIcon /> : null}
      </span>
      <div>
        <p className={styles.title}>{title}</p>
        {detail ? <p className={styles.detail}>{detail}</p> : null}
      </div>
    </div>
  )
}
