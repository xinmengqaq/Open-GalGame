import { useEffect, useRef, type ReactElement } from 'react'

import { guideStepById, guideStepTotal, isGuideStepId } from './guideSteps'
import { useGuideDrag, type GuideOverlayLayout } from './guideDrag'
import styles from './GuideEntry.module.css'

interface GuideEntryProps {
  lastStepId: string | null
  /** 预览页占用整屏时把入口放到左下，避免压住舞台控制与返回按钮。 */
  layout?: GuideOverlayLayout
  onOpen: () => void
  onClose: () => void
}

/**
 * 外壳级独立入口：默认停在视口角落，可拖到别处，始终留在最上层。
 * 低干扰但保留可读标签，鼠标和键盘都能进入。退出教程后入口仍在，
 * 点击先打开邀请，用户接受后才重新进入教程模式；右侧 × 关闭入口。
 */
export function GuideEntry({
  lastStepId,
  layout = 'default',
  onOpen,
  onClose
}: GuideEntryProps): ReactElement {
  const step = lastStepId && isGuideStepId(lastStepId) ? guideStepById(lastStepId) : null
  const meta = step ? `第 ${step.number} 步` : `${guideStepTotal()} 步上手`
  const accessibleName = step
    ? `打开新手教程，从第 ${step.number} 步「${step.title}」继续`
    : '打开新手教程，从第一步开始'
  const drag = useGuideDrag(layout)
  const groupRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const node = groupRef.current
    if (!node) return
    const reclamp = drag.reclamp.bind(null, node)
    reclamp()
    window.addEventListener('resize', reclamp)
    const observer = new ResizeObserver(reclamp)
    observer.observe(node)
    return () => {
      window.removeEventListener('resize', reclamp)
      observer.disconnect()
    }
  }, [drag.reclamp])

  return (
    <div
      ref={groupRef}
      className={styles.entryGroup}
      style={drag.style}
      data-layout={layout}
      data-guide-entry-group="true"
      data-dragging={drag.dragging || undefined}
      onPointerDown={(event) => drag.start(event, groupRef.current)}
      onClickCapture={(event) => {
        if (!drag.consumeClick()) return
        event.preventDefault()
        event.stopPropagation()
      }}
    >
      <button
        type="button"
        className={styles.entry}
        onClick={onOpen}
        aria-label={accessibleName}
        title={accessibleName}
        data-guide-entry="true"
        data-layout={layout}
      >
        <span className={styles.mark} aria-hidden="true">
          <svg
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.35"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3.1 6.1c1.75-.95 3.45-.7 5.05.6v8.65c-1.6-1.3-3.3-1.55-5.05-.6z" />
            <path d="M16.9 6.1c-1.75-.95-3.45-.7-5.05.6v8.65c1.6-1.3 3.3-1.55 5.05-.6z" />
            <path
              d="M5.6 8.2c.55-.15 1.05-.1 1.5.1M5.6 10.2c.55-.15 1.05-.1 1.5.1M14.4 8.2c-.55-.15-1.05-.1-1.5.1"
              opacity="0.55"
            />
            <path
              d="M16.1 3.1l.4 1.1 1.1.4-1.1.4-.4 1.1-.4-1.1-1.1-.4 1.1-.4z"
              fill="currentColor"
              stroke="none"
            />
          </svg>
        </span>
        <span className={styles.label}>新手教程</span>
        <span className={styles.meta}>{meta}</span>
      </button>
      <button
        type="button"
        className={styles.entryExit}
        onClick={onClose}
        aria-label="关闭新手教程"
        title="关闭新手教程，可在设置中重新打开"
        data-guide-entry-exit="true"
      >
        <svg
          viewBox="0 0 14 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="m3.9 3.9 6.2 6.2M10.1 3.9 3.9 10.1" />
        </svg>
      </button>
    </div>
  )
}
