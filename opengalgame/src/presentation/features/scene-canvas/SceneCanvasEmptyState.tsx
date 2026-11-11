import type { ReactElement } from 'react'

import { Button } from '../../components/Button'
import { workbenchFeedback } from '../../feedback/workbenchFeedback'
import { SparkIcon } from './SceneCanvasIcons'
import styles from './SceneCanvas.module.css'

interface SceneCanvasEmptyStateProps {
  onAddPrompt: () => void
}

/**
 * 没有卡片时的画布引导。图形、标题和说明直接落在画布洗光上，
 * 只保留一个主操作；动画和特效统一从底栏 dock 新增。
 */
export function SceneCanvasEmptyState({ onAddPrompt }: SceneCanvasEmptyStateProps): ReactElement {
  return (
    <div className={styles.empty} data-testid="canvas-empty" data-motion="canvas-empty">
      <span className={styles.emptyScene} aria-hidden="true">
        <span className={styles.emptyAura} />
        <svg className={styles.emptySketch} viewBox="0 0 236 158">
          <g className={styles.emptyCardBack}>
            <rect x="22" y="18" width="94" height="60" rx="15" fill="none" />
            <path d="M38 36h34M38 47h48M38 58h24" opacity="0.32" />
          </g>
          <g className={styles.emptyCardFront}>
            <rect x="124" y="56" width="92" height="64" rx="16" fill="none" />
            <path d="M140 78h46M140 90h30" opacity="0.42" />
          </g>
          <path className={styles.emptyLink} d="M108 44c22 4 26 34 50 34" />
          <circle className={styles.emptyNode} cx="108" cy="44" r="2.6" />
          <circle className={styles.emptyNode} cx="158" cy="78" r="2.6" />
          <path
            className={styles.emptySpark}
            d="M96 104l2.8 6.8 6.8 2.8-6.8 2.8-2.8 6.8-2.8-6.8-6.8-2.8 6.8-2.8Z"
          />
        </svg>
      </span>
      <p className={styles.emptyEyebrow}>空画布 · 从这里开始</p>
      <h2>让这一场，慢慢成形。</h2>
      <p className={styles.emptyGuide}>{workbenchFeedback.emptyGuide}</p>
      <div className={styles.emptyActions}>
        <Button onClick={onAddPrompt} title="在视口中心添加提示词卡">
          <SparkIcon />
          添加提示词
        </Button>
      </div>
      <p className={styles.emptyHint}>{workbenchFeedback.emptyHint}</p>
      <p className={styles.emptyNote}>{workbenchFeedback.canvasLayout}</p>
    </div>
  )
}
