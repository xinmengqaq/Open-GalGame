import type { ReactElement } from 'react'

import { ContentKindIcon } from '../workbench-session/ContentKindIcon'
import { CardMediaOffIcon } from './InputCardIcons'
import styles from './SceneInputCards.module.css'

interface MediaFallbackProps {
  kind: 'image' | 'video'
  state: string
  /** 真实读取失败时的重试入口；来源断开或不可读取时不提供。 */
  onRetry?: () => void
}

/** 没有真实媒体字节时的来源占位，明确说明当前不可预览。 */
export function MediaFallback({ kind, state, onRetry }: MediaFallbackProps): ReactElement {
  return (
    <div className={styles.mediaFallback} data-media-state={state}>
      <span className={styles.mediaEmblem} aria-hidden="true">
        <ContentKindIcon contentKind={kind} />
        <span className={styles.mediaOffMark}>
          <CardMediaOffIcon />
        </span>
      </span>
      <span className={styles.mediaHeadline}>{state}</span>
      {onRetry ? (
        <button type="button" className={styles.mediaRetry} onClick={onRetry}>
          重新读取
        </button>
      ) : null}
    </div>
  )
}
