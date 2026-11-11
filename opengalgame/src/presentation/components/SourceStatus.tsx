import { clsx } from 'clsx'
import { useRef, type ReactElement } from 'react'

import { workbenchFeedback } from '../feedback/workbenchFeedback'
import { CardQuestionIcon } from './SourceStatusIcons'
import styles from './SourceStatus.module.css'
import { useSourceStatusMotion } from './useSourceStatusMotion'

export type SourceStatusCode = 'readable' | 'unreadable' | 'disconnected'

/** 共享状态只声明映射需要的来源事实，不反向依赖领域选择器。 */
export interface SourceStatusFacts {
  readable: boolean
  disconnected?: boolean
}

const statusLabels: Record<SourceStatusCode, string> = {
  readable: '来源可读取',
  unreadable: '来源不可读取',
  disconnected: workbenchFeedback.disconnected
}

/** 来源事实到状态码的唯一映射：断开优先于不可读取。 */
export function sourceStatusOf(facts: SourceStatusFacts): SourceStatusCode {
  if (facts.disconnected) return 'disconnected'
  return facts.readable ? 'readable' : 'unreadable'
}

export interface SourceStatusProps {
  code: SourceStatusCode
  /** 覆盖默认文案；调用方保证状态与文案一致。 */
  label?: string
  /** card 用于卡片头部，compact 用于目录行。 */
  density?: 'card' | 'compact'
  /** 状态变化与初次出现时的显现动效。 */
  motion?: boolean
  className?: string
}

/**
 * 来源状态：色点、文字和色调共同表达，可被卡片头部和目录行复用。
 * 状态是内联的一行，不套胶囊、底纹或整圈边框。
 */
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

/**
 * 文档格式状态。格式未知使用暖色状态点与疑问图标，和来源断开、不可读取区分。
 */
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
