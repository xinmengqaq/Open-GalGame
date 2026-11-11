import type { ReactElement, ReactNode } from 'react'

import styles from './GameStageFrame.module.css'

interface GameStageLoadingProps {
  readonly title: string
  readonly description?: string
  readonly action?: ReactNode
}

/**
 * 舞台未就绪时的轻量提示层。它只说明当前等待，不生成演示画面，
 * 也不把遮罩消失当成真实就绪。
 */
export function GameStageLoading({
  title,
  description,
  action
}: GameStageLoadingProps): ReactElement {
  return (
    <div className={styles.loading} role="status">
      <span className={styles.spinner} aria-hidden="true" />
      <strong>{title}</strong>
      {description ? <p>{description}</p> : null}
      {action ? <div className={styles.loadingAction}>{action}</div> : null}
    </div>
  )
}
