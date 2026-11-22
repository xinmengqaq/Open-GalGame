import { clsx } from 'clsx'
import type { ReactElement, ReactNode } from 'react'

import styles from './GameStageFrame.module.css'

export type GameStageFrameStatus = 'loading' | 'ready' | 'failed'

export const GAME_STAGE_IFRAME_ALLOW = 'autoplay; fullscreen'

interface GameStageFrameProps {
  readonly src: string | null
  readonly title: string
  readonly status: GameStageFrameStatus
  readonly frameToken?: number | string
  readonly onStageLoad?: () => void
  readonly children?: ReactNode
  readonly className?: string
}

export function GameStageFrame({
  src,
  title,
  status,
  frameToken = 0,
  onStageLoad,
  children,
  className
}: GameStageFrameProps): ReactElement {
  return (
    <div className={clsx(styles.frame, className)} data-stage-status={status}>
      {src === null ? (
        <div className={styles.emptyStage} aria-hidden="true" />
      ) : (
        <iframe
          key={`${src}:${frameToken}`}
          className={styles.iframe}
          src={src}
          title={title}
          allow={GAME_STAGE_IFRAME_ALLOW}
          referrerPolicy="no-referrer"
          onLoad={() => onStageLoad?.()}
        />
      )}
      <div className={styles.veil} aria-hidden="true">
        <span className={styles.veilGlow} />
        <span className={styles.veilShimmer} />
      </div>
      <div className={styles.overlay}>{children}</div>
    </div>
  )
}
