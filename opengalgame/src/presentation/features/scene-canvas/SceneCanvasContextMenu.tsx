import { useEffect, type ReactElement } from 'react'
import { createPortal } from 'react-dom'

import { CopyIcon, EditIcon, TrashIcon } from './SceneCanvasIcons'
import styles from './SceneCanvas.module.css'
import type { CanvasMenuState } from './sceneCanvas.types'

interface SceneCanvasContextMenuProps {
  menu: CanvasMenuState
  onEdit: () => void
  onCopy: () => void
  onDelete: () => void
  onClose: () => void
}

export function SceneCanvasContextMenu({
  menu,
  onEdit,
  onCopy,
  onDelete,
  onClose
}: SceneCanvasContextMenuProps): ReactElement | null {
  useEffect(() => {
    if (!menu) return
    const close = (): void => onClose()
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [menu, onClose])

  if (!menu) return null
  return createPortal(
    <div
      className={styles.menu}
      style={{ left: menu.x, top: menu.y }}
      role="menu"
      aria-label="卡片操作"
      data-testid="canvas-card-menu"
    >
      <header className={styles.menuHeader}>
        <span>输入卡片</span>
        <small>作用于当前画布</small>
      </header>
      {menu.editLabel ? (
        <button type="button" role="menuitem" onClick={onEdit}>
          <EditIcon />
          {menu.editLabel}
        </button>
      ) : null}
      <button type="button" role="menuitem" onClick={onCopy}>
        <CopyIcon />
        复制卡片
      </button>
      <button type="button" role="menuitem" className={styles.menuDanger} onClick={onDelete}>
        <TrashIcon />
        删除卡片
        <kbd>Del</kbd>
      </button>
    </div>,
    document.body
  )
}
