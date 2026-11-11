import { useReactFlow, useViewport } from '@xyflow/react'
import { clsx } from 'clsx'
import { useCallback, type ReactElement } from 'react'

import { PlusIcon } from '../../components/Icons'
import { Button } from '../../components/Button'
import { prefersReducedMotion } from '../../effects/motion'
import { FitIcon, MinusIcon, RedoIcon, UndoIcon } from '../../pages/workbench/WorkbenchIcons'
import type { RegisterWorkbenchInset } from '../../pages/workbench/shell/workbenchLayout'
import { useWorkbenchCommands } from '../workbench-session/workbenchCommandsContext'
import { useWorkbenchSessionStore } from '../workbench-session/workbenchSession.store'
import { EffectIcon, MotionIcon, SparkIcon } from './SceneCanvasIcons'
import styles from './SceneCanvas.module.css'

interface SceneCanvasToolbarProps {
  onAddPrompt: () => void
  onAddAnimation: () => void
  onAddEffect: () => void
  registerInset?: RegisterWorkbenchInset
}

/** 底栏 dock：视图、撤销重做与唯一的三类新增入口，空间由画布安全区让出。 */
export function SceneCanvasToolbar({
  onAddPrompt,
  onAddAnimation,
  onAddEffect,
  registerInset
}: SceneCanvasToolbarProps): ReactElement {
  const commands = useWorkbenchCommands()
  const { zoomIn, zoomOut, fitView } = useReactFlow()
  const { zoom } = useViewport()
  const past = useWorkbenchSessionStore((state) => state.past)
  const future = useWorkbenchSessionStore((state) => state.future)
  const reduced = prefersReducedMotion()
  const percent = Math.round(zoom * 100)
  const registerDock = useCallback(
    (node: HTMLElement | null) => registerInset?.('bottomDock', node),
    [registerInset]
  )

  return (
    <footer
      ref={registerDock}
      className={styles.dock}
      data-motion="toolbar"
      data-testid="canvas-dock"
      aria-label="画布工具栏"
    >
      <div className={styles.toolbar}>
        <div className={styles.toolbarGroup} data-motion="toolbar-group" data-group="view">
          <Button
            variant="secondary"
            className={styles.toolButton}
            aria-label="缩小画布"
            title="缩小画布"
            onClick={() => void zoomOut({ duration: reduced ? 0 : 180 })}
          >
            <MinusIcon />
          </Button>
          <span className={styles.zoomValue} title="当前缩放比例">
            {percent}%
          </span>
          <Button
            variant="secondary"
            className={styles.toolButton}
            aria-label="放大画布"
            title="放大画布"
            onClick={() => void zoomIn({ duration: reduced ? 0 : 180 })}
          >
            <PlusIcon />
          </Button>
          <Button
            variant="secondary"
            className={styles.toolButton}
            aria-label="适配画布"
            title="适配画布"
            onClick={() =>
              void fitView({ padding: 0.14, maxZoom: 1.1, duration: reduced ? 0 : 420 })
            }
          >
            <FitIcon />
            <span className={styles.toolLabel}>适配</span>
          </Button>
        </div>

        <span className={styles.toolbarSep} aria-hidden="true" />

        <div className={styles.toolbarGroup} data-motion="toolbar-group" data-group="history">
          <Button
            variant="secondary"
            className={styles.toolButton}
            aria-label="撤销"
            title="撤销 Ctrl/Cmd+Z"
            disabled={past.length === 0}
            onClick={() => commands.undo()}
          >
            <UndoIcon />
          </Button>
          <Button
            variant="secondary"
            className={styles.toolButton}
            aria-label="重做"
            title="重做 Ctrl/Cmd+Shift+Z"
            disabled={future.length === 0}
            onClick={() => commands.redo()}
          >
            <RedoIcon />
          </Button>
        </div>

        <span className={styles.toolbarSep} aria-hidden="true" />

        <div className={styles.toolbarGroup} data-motion="toolbar-group" data-group="create">
          <span className={styles.createLabel} aria-hidden="true">
            新增
          </span>
          <Button
            variant="secondary"
            className={clsx(styles.addButton, styles.addPrompt)}
            onClick={onAddPrompt}
            aria-label="添加提示词卡"
            title="在视口中心添加提示词卡"
          >
            <span className={styles.addIcon}>
              <SparkIcon />
            </span>
            <span className={styles.toolLabel}>提示词</span>
          </Button>
          <Button
            variant="secondary"
            className={clsx(styles.addButton, styles.addAnimation)}
            onClick={onAddAnimation}
            aria-label="添加动画卡"
            title="在视口中心添加动画卡"
          >
            <span className={styles.addIcon}>
              <MotionIcon />
            </span>
            <span className={styles.toolLabel}>动画</span>
          </Button>
          <Button
            variant="secondary"
            className={clsx(styles.addButton, styles.addEffect)}
            onClick={onAddEffect}
            aria-label="添加特效卡"
            title="在视口中心添加特效卡"
          >
            <span className={styles.addIcon}>
              <EffectIcon />
            </span>
            <span className={styles.toolLabel}>特效</span>
          </Button>
        </div>
      </div>
    </footer>
  )
}
