import { clsx } from 'clsx'
import type { ReactElement } from 'react'

import styles from './RelationLayer.module.css'

export type ConnectionPortState = 'idle' | 'named' | 'unnamed' | 'ready' | 'active' | 'rejected'

interface ConnectionPortProps {
  shape?: 'diamond' | 'circle'
  state?: ConnectionPortState
  className?: string
}

/** 连接端口的可见形状；命中区域由外层 Handle 提供。 */
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
