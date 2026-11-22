import { clsx } from 'clsx'
import type { ReactElement } from 'react'

import styles from './RelationLayer.module.css'

export type ConnectionPortState = 'idle' | 'named' | 'unnamed' | 'ready' | 'active' | 'rejected'

interface ConnectionPortProps {
  shape?: 'diamond' | 'circle'
  state?: ConnectionPortState
  className?: string
}

export function ConnectionPort({
  shape = 'diamond',
  state = 'idle',
  className
}: ConnectionPortProps): ReactElement {
  return (
    <span
      className={clsx(styles.port, className)}
      data-shape={shape}
      data-state={state}
      aria-hidden="true"
    />
  )
}
