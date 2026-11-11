import { clsx } from 'clsx'
import type { ReactElement } from 'react'

import { PlusIcon } from '../../components/Icons'
import styles from './SceneCanvas.module.css'

export function SceneCanvasDropZone({ active }: { active: boolean }): ReactElement | null {
  if (!active) return null
  return (
    <div className={clsx(styles.dropZone)} data-testid="canvas-drop-zone">
      <div className={styles.dropZoneInner}>
        <span className={styles.dropZoneIcon} aria-hidden="true">
          <PlusIcon />
        </span>
        <strong className={styles.dropZoneTitle}>放在这里，加入这一场</strong>
        <span className={styles.dropZoneHint}>松开后按来源类型创建画布卡片</span>
      </div>
    </div>
  )
}
