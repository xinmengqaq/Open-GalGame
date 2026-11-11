import { clsx } from 'clsx'
import type { ReactElement, ReactNode } from 'react'

import styles from './GameStageFrame.module.css'

export type GameStageFrameStatus = 'loading' | 'ready' | 'failed'

/**
 * 舞台是独立源的嵌入页，声音仍由页面内的真实点击启用。
 * 这里只把浏览器的 autoplay 权限委托给舞台，不注入脚本、不模拟点击，
 * 也不读取引擎内部的 BGM 状态。
 */
export const GAME_STAGE_IFRAME_ALLOW = 'autoplay; fullscreen'

interface GameStageFrameProps {
  /** 只接受调用方已经确认的舞台地址；null 时不创建 iframe。 */
  readonly src: string | null
  readonly title: string
  /**
   * 由真实返回或事件决定。iframe load 只回调 `onStageLoad`，
   * 不能据此把状态改成 ready。
   */
  readonly status: GameStageFrameStatus
  readonly frameToken?: number | string
  readonly onStageLoad?: () => void
  /** 浮在舞台上的加载、错误或状态层，由调用方按真实事实提供。 */
  readonly children?: ReactNode
  readonly className?: string
}

/**
 * 当前场景和候选共用的唯一舞台节点与画面层。
 * 组件不推断播放状态，也不把页面加载当就绪；加载遮罩只跟随传入的 status。
 */
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
