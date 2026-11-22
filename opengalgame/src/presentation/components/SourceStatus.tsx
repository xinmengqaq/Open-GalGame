import { clsx } from 'clsx'
import { useRef, type ReactElement } from 'react'

import { workbenchFeedback } from '../feedback/workbenchFeedback'
import { CardQuestionIcon } from './SourceStatusIcons'
import type { SourceStatusCode } from './sourceStatusMapping'
import styles from './SourceStatus.module.css'
import { useSourceStatusMotion } from './useSourceStatusMotion'

const statusLabels: Record<SourceStatusCode, string> = {
  readable: '来源可读取',
  unreadable: '来源不可读取',
  disconnected: workbenchFeedback.disconnected
}

export interface SourceStatusProps {
  code: SourceStatusCode
  label?: string
  density?: 'card' | 'compact'
  motion?: boolean
  className?: string
}

export function SourceStatus({
  code,
  label,
  density = 'card',
  motion = false,
  className
}: SourceStatusProps): ReactElement {
  const root = useRef<HTMLSpanElement>(null)
  const text = label ?? statusLabels[code]
  useSourceStatusMotion(root, `${code}:${text}`, motion)

  return (
    <span
      ref={root}
      className={clsx(
        styles.status,
        styles[code],
        density === 'compact' && styles.compact,
        className
      )}
      data-source-status={code}
      data-density={density}
      data-motion="source-status"
      title={text}
    >
      <span className={styles.dot} data-motion="source-status-icon" aria-hidden="true" />
      <span className={styles.text}>{text}</span>
    </span>
  )
}

export function FormatStatus({
  format,
  className
}: {
  format: string | null
  className?: string
}): ReactElement {
  const known = format !== null && format.trim().length > 0
  return (
    <span
      className={clsx(styles.format, !known && styles.formatUnknown, className)}
      data-format-state={known ? 'known' : 'unknown'}
      title={known ? `文档格式：${format}` : '还没有识别到文档格式'}
    >
      {known ? null : (
        <span className={styles.formatIcon} aria-hidden="true">
          <CardQuestionIcon />
        </span>
      )}
      {known ? format : '格式未知'}
    </span>
  )
}
