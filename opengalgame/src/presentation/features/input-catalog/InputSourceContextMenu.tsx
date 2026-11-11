import { clsx } from 'clsx'
import {
  useEffect,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'

import { ImportIcon } from '../../pages/workbench/WorkbenchIcons'
import theme from '../../pages/workbench/workbenchTheme.module.css'
import {
  CopyIcon,
  CutIcon,
  ExternalIcon,
  FileGlyphIcon,
  FolderIcon,
  FolderPlusIcon,
  PasteIcon,
  PencilIcon,
  PlusIcon,
  SparkIcon,
  TrashIcon
} from './InputCatalogIcons'
import type { CatalogMenuState } from './inputCatalog.types'
import { useContextMenuMotion } from './useInputCatalogMotion'
import styles from './InputCatalogPanel.module.css'

interface InputSourceContextMenuProps {
  menu: CatalogMenuState
  targetName: string | null
  targetMeta: string | null
  useOnCanvasEnabled: boolean
  pasteEnabled: boolean
  busy: boolean
  onUseOnCanvas: () => void
  onCut: () => void
  onCopyFile: () => void
  onRenameFile: () => void
  onDeleteFile: () => void
  onOpen: () => void
  onCreateMaterial: () => void
  onCreateFolder: () => void
  onPaste: () => void
  onCopyFolder: () => void
  onRenameFolder: () => void
  onDeleteFolder: () => void
  onImport: () => void
  onClose: () => void
}

/** 文件、文件夹和空白区域菜单。限制在窗口内，点击外部或 Escape 关闭。 */
export function InputSourceContextMenu({
  menu,
  targetName,
  targetMeta,
  useOnCanvasEnabled,
  pasteEnabled,
  busy,
  onUseOnCanvas,
  onCut,
  onCopyFile,
  onRenameFile,
  onDeleteFile,
  onOpen,
  onCreateMaterial,
  onCreateFolder,
  onPaste,
  onCopyFolder,
  onRenameFolder,
  onDeleteFolder,
  onImport,
  onClose
}: InputSourceContextMenuProps): ReactElement | null {
  const node = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menu) return
    const close = (event: MouseEvent): void => {
      if (node.current?.contains(event.target as Node)) return
      onClose()
    }
    const closeOnEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [menu, onClose])

  useLayoutEffect(() => {
    if (!menu || !node.current) return
    const rect = node.current.getBoundingClientRect()
    const left = Math.max(8, Math.min(menu.x, window.innerWidth - rect.width - 8))
    const top = Math.max(8, Math.min(menu.y, window.innerHeight - rect.height - 8))
    node.current.style.left = `${left}px`
    node.current.style.top = `${top}px`
    const first = node.current.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
    first?.focus({ preventScroll: true })
  }, [menu])

  useContextMenuMotion(node, menu ? `${menu.kind}:${menu.x}:${menu.y}` : 'closed')

  if (!menu) return null

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (!node.current) return
    const items = Array.from(
      node.current.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
    )
    if (items.length === 0) return
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      const next = (current + step + items.length) % items.length
      items[next]?.focus()
    } else if (event.key === 'Home') {
      event.preventDefault()
      items[0]?.focus()
    } else if (event.key === 'End') {
      event.preventDefault()
      items[items.length - 1]?.focus()
    }
  }

  return createPortal(
    <div
      ref={node}
      className={clsx(styles.menu, theme.theme)}
      style={{ left: menu.x, top: menu.y }}
      role="menu"
      data-testid="file-context-menu"
      data-menu-kind={menu.kind}
      onKeyDown={onMenuKeyDown}
    >
      <div className={styles.menuHeader}>
        <span className={styles.menuHeaderIcon} aria-hidden="true">
          {menu.kind === 'folder' ? (
            <FolderIcon open />
          ) : menu.kind === 'file' ? (
            <FileGlyphIcon />
          ) : (
            <FolderPlusIcon />
          )}
        </span>
        <span className={styles.menuHeaderText}>
          <strong title={targetName ?? undefined}>{targetName ?? '当前目录'}</strong>
          <small>{targetMeta}</small>
        </span>
      </div>

      {menu.kind === 'file' ? (
        <>
          <div className={styles.menuGroup} role="none">
            <MenuItem
              icon={<PlusIcon />}
              label="在画布中使用"
              disabled={!useOnCanvasEnabled}
              onClick={onUseOnCanvas}
            />
            <MenuItem icon={<CutIcon />} label="剪切" disabled={busy} onClick={onCut} />
            <MenuItem icon={<CopyIcon />} label="复制" disabled={busy} onClick={onCopyFile} />
            <MenuItem icon={<PencilIcon />} label="重命名" disabled={busy} onClick={onRenameFile} />
          </div>
          <div className={styles.menuSplit} />
          <div className={styles.menuGroup} role="none">
            <MenuItem
              icon={<TrashIcon />}
              label="删除"
              danger
              disabled={busy}
              onClick={onDeleteFile}
            />
            <MenuItem
              icon={<ExternalIcon />}
              label="用系统程序打开"
              disabled={busy}
              onClick={onOpen}
            />
          </div>
        </>
      ) : null}

      {menu.kind === 'folder' ? (
        <>
          <div className={styles.menuGroup} role="none">
            <MenuItem
              icon={<SparkIcon />}
              label="新建素材"
              disabled={busy}
              onClick={onCreateMaterial}
            />
            <MenuItem
              icon={<FolderPlusIcon />}
              label="新建文件夹"
              disabled={busy}
              onClick={onCreateFolder}
            />
            <MenuItem
              icon={<PasteIcon />}
              label="粘贴"
              disabled={!pasteEnabled || busy}
              onClick={onPaste}
            />
          </div>
          <div className={styles.menuSplit} />
          <div className={styles.menuGroup} role="none">
            <MenuItem icon={<CopyIcon />} label="复制" disabled={busy} onClick={onCopyFolder} />
            <MenuItem
              icon={<PencilIcon />}
              label="重命名"
              disabled={busy}
              onClick={onRenameFolder}
            />
            <MenuItem
              icon={<TrashIcon />}
              label="删除"
              danger
              disabled={busy}
              onClick={onDeleteFolder}
            />
          </div>
        </>
      ) : null}

      {menu.kind === 'blank' ? (
        <>
          <div className={styles.menuGroup} role="none">
            <MenuItem
              icon={<SparkIcon />}
              label="新建素材"
              disabled={busy}
              onClick={onCreateMaterial}
            />
            <MenuItem
              icon={<FolderPlusIcon />}
              label="新建文件夹"
              disabled={busy}
              onClick={onCreateFolder}
            />
            <MenuItem icon={<ImportIcon />} label="导入素材" disabled={busy} onClick={onImport} />
            <MenuItem
              icon={<PasteIcon />}
              label="粘贴"
              disabled={!pasteEnabled || busy}
              onClick={onPaste}
            />
          </div>
        </>
      ) : null}
    </div>,
    document.body
  )
}

function MenuItem({
  icon,
  label,
  disabled,
  danger,
  onClick
}: {
  icon: ReactNode
  label: string
  disabled?: boolean
  danger?: boolean
  onClick: () => void
}): ReactElement {
  return (
    <button
      type="button"
      role="menuitem"
      className={danger ? `${styles.menuItem} ${styles.menuDanger}` : styles.menuItem}
      disabled={disabled}
      onClick={onClick}
    >
      <span className={styles.menuItemIcon} aria-hidden="true">
        {icon}
      </span>
      {label}
    </button>
  )
}
