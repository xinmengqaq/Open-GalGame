import { clsx } from 'clsx'
import { useRef, type ReactElement, type ReactNode } from 'react'

import { ContentKindIcon } from '../workbench-session/ContentKindIcon'
import { cardIconProps, cardKindLabel } from '../workbench-session/contentKindLabel'
import type { SessionCard } from '../workbench-session/workbenchSession.types'
import styles from './CanvasCardFrame.module.css'
import { useCardEntranceMotion, useCardFrameMotion } from './useInputCardMotion'

export type CanvasCardLayout = 'card' | 'media' | 'paper'

interface CanvasCardFrameProps {
  card: SessionCard
  selected: boolean
  /** 头部右侧固定状态槽。来源卡放来源状态，字段卡放预设状态。 */
  status?: ReactNode
  /** 卡片自身内容；不拥有外框、头部和状态槽。 */
  children: ReactNode
  /** 底部独立操作槽，例如文档阅读入口。 */
  actions?: ReactNode
  /** card 为常规浮块，media 让预览区撑满，paper 为无头部的正文表面。 */
  layout?: CanvasCardLayout
  /** 预览卡高度由节点决定时撑满可用高度。 */
  fill?: boolean
  /** 来源断开或不可读取时铺一层玫瑰柔光，并在状态槽说明原因。 */
  risk?: boolean
  className?: string
}

/**
 * 卡片共同外框：类型光点、头部、固定状态槽、内容区和操作槽。
 * 选中、悬停、来源风险与动效都在这里统一，卡片内容不重复定义外框。
 */
export function CanvasCardFrame({
  card,
  selected,
  status,
  children,
  actions,
  layout = 'card',
  fill = false,
  risk = false,
  className
}: CanvasCardFrameProps): ReactElement {
  const root = useRef<HTMLElement>(null)
  const icon = cardIconProps(card)
  useCardEntranceMotion(root)
  useCardFrameMotion(root, selected)

  return (
    <article
      ref={root}
      className={clsx(styles.frame, className)}
      data-kind={card.kind}
      data-card-kind={card.kind}
      data-layout={layout}
      data-selected={selected}
      data-risk={risk || undefined}
      data-fill={fill || undefined}
      data-card-surface="frame"
    >
      {layout !== 'media' ? (
        <span className={styles.selectAura} data-motion="card-seal" aria-hidden="true" />
      ) : null}
      {layout === 'paper' || layout === 'media' ? null : (
        <header className={styles.header}>
          <span className={styles.kind}>
            <span className={styles.kindIcon} aria-hidden="true">
              <ContentKindIcon contentKind={icon.contentKind} textKind={icon.textKind} />
            </span>
            <span className={styles.kindLabel}>{cardKindLabel(card.kind)}</span>
          </span>
          <span className={styles.statusSlot} data-card-status-slot>
            {status}
          </span>
        </header>
      )}
      <div className={styles.content}>{children}</div>
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </article>
  )
}
