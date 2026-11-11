import type { ReactElement, ReactNode } from 'react'

import styles from './Stage.module.css'

export function Stage({ children }: { children: ReactNode }): ReactElement {
  return (
    <div className={styles.viewport} data-stage-viewport>
      <div className={styles.canvas} data-stage-canvas>
        {children}
      </div>
    </div>
  )
}
