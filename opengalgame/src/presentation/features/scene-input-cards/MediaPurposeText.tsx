import { clsx } from 'clsx'
import type { ReactElement } from 'react'

import { CardEditIcon } from './InputCardIcons'
import styles from './SceneInputCards.module.css'

interface MediaPurposeTextProps {
  summary: string
  /** 打开卡片的标题与用途说明编辑；不传时保持纯文本。 */
  onEdit?: () => void
}

/**
 * 媒体卡用途说明。它是标题下的安静信息层：最多两行，全文放在 title 里；
 * 没有说明时保留一处可识别的空态，不显示来源角色或成功状态。
 */
export function MediaPurposeText({ summary, onEdit }: MediaPurposeTextProps): ReactElement {
  const text = summary.trim()
  const hasText = text.length > 0
  if (!onEdit) {
    return (
      <p
        className={styles.mediaSummary}
        data-empty={hasText ? undefined : 'true'}
        title={hasText ? text : undefined}
      >
        {hasText ? text : '未写用途说明'}
      </p>
    )
  }
  return (
    <button
      type="button"
      className={clsx(styles.mediaSummary, styles.mediaSummaryAction, 'nodrag nopan')}
      data-empty={hasText ? undefined : 'true'}
      title={hasText ? `${text}（点击编辑）` : '添加用途说明'}
      aria-label={hasText ? '编辑标题和用途说明' : '添加用途说明'}
      onClick={(event) => {
        event.stopPropagation()
        onEdit()
      }}
    >
      <span className={styles.mediaSummaryText}>{hasText ? text : '未写用途说明'}</span>
      {hasText ? null : (
        <span className={styles.mediaSummaryHint} aria-hidden="true">
          <CardEditIcon />
        </span>
      )}
    </button>
  )
}
