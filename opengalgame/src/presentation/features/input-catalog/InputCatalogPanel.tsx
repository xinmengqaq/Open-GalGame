import { clsx } from 'clsx'
import { useEffect, useRef, useState, type DragEvent, type ReactElement } from 'react'

import type { ProjectFilesClient } from '@interfaces/project-files/client/ProjectFilesClient'
import { Button } from '../../components/Button'
import { ImportIcon } from '../../pages/workbench/WorkbenchIcons'
import { EmptyDocumentEditor } from '../document-layer/EmptyDocumentEditor'
import { contentKindLabel } from '../workbench-session/contentKindLabel'
import { SOURCE_DRAG_MIME } from '../workbench-session/workbenchSession.types'
import { InputCatalogBreadcrumbs } from './InputCatalogBreadcrumbs'
import {
  CatalogCreateDialog,
  CatalogDeleteFileDialog,
  CatalogDeleteFolderDialog,
  CatalogNameDialogView
} from './InputCatalogDialogs'
import { InputCatalogEmptyState } from './InputCatalogEmptyState'
import { InputCatalogFailureState } from './InputCatalogFailureState'
import { InputCatalogFilterBar } from './InputCatalogFilterBar'
import { InputCatalogHeader } from './InputCatalogHeader'
import { ClipIcon, CloseIcon, FolderPlusIcon, SparkIcon, WarningDotIcon } from './InputCatalogIcons'
import { InputFolderTree } from './InputFolderTree'
import { InputSourceContextMenu } from './InputSourceContextMenu'
import { useInputCatalog } from './useInputCatalog'
import {
  useClipboardBannerMotion,
  useDropOverlayMotion,
  useStateArtMotion
} from './useInputCatalogMotion'
import styles from './InputCatalogPanel.module.css'

interface InputCatalogPanelProps {
  client: ProjectFilesClient
  onRefresh: () => void
}

export function InputCatalogPanel({ client, onRefresh }: InputCatalogPanelProps): ReactElement {
  const catalog = useInputCatalog(client)
  const menu = catalog.menu
  const clipboard = catalog.clipboard
  const [dropActive, setDropActive] = useState(false)
  const overlayRef = useRef<HTMLDivElement>(null)
  const clipRef = useRef<HTMLParagraphElement>(null)

  const currentFolderName = catalog.breadcrumbs[catalog.breadcrumbs.length - 1]?.name ?? '工程根'
  const menuSource =
    menu?.kind === 'file'
      ? catalog.sources.find((source) => source.sourceId === menu.sourceId)
      : undefined
  const menuFolder =
    menu?.kind === 'folder'
      ? catalog.folders.find((folder) => folder.folderId === menu.folderId)
      : undefined
  const menuTargetName =
    menuSource?.name ?? menuFolder?.name ?? (menu?.kind === 'blank' ? currentFolderName : null)
  const menuTargetMeta =
    menu?.kind === 'file' && menuSource
      ? `${contentKindLabel(
          menuSource.contentKind,
          menuSource.contentKind === 'text' ? menuSource.textKind : undefined
        )} · ${menuSource.readable ? '可读取' : '不可读取'}`
      : menu?.kind === 'folder'
        ? '文件夹 · 双击进入'
        : menu?.kind === 'blank'
          ? '在这里新建或导入'
          : null

  const clipboardName = clipboard
    ? clipboard.kind === 'file'
      ? (catalog.sources.find((source) => source.sourceId === clipboard.sourceId)?.name ?? '文件')
      : (catalog.folders.find((folder) => folder.folderId === clipboard.folderId)?.name ?? '文件夹')
    : ''
  const clipboardSignature = clipboard ? `${clipboard.kind}:${clipboard.mode}:${clipboardName}` : ''

  useClipboardBannerMotion(clipRef, clipboardSignature)
  useDropOverlayMotion(overlayRef, dropActive)

  useEffect(() => {
    const clear = (): void => setDropActive(false)
    window.addEventListener('drop', clear, true)
    window.addEventListener('dragend', clear, true)
    return () => {
      window.removeEventListener('drop', clear, true)
      window.removeEventListener('dragend', clear, true)
    }
  }, [])

  useEffect(() => {
    if (catalog.busy) setDropActive(false)
  }, [catalog.busy])

  function isExternalFileDrag(event: DragEvent): boolean {
    return (
      event.dataTransfer.types.includes('Files') &&
      !event.dataTransfer.types.includes(SOURCE_DRAG_MIME)
    )
  }

  function handleDragEnter(event: DragEvent): void {
    if (!isExternalFileDrag(event) || catalog.busy) return
    setDropActive(true)
  }

  function handleDragLeave(event: DragEvent): void {
    if (!isExternalFileDrag(event)) return
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
    setDropActive(false)
  }

  function handleDrop(event: DragEvent): void {
    setDropActive(false)
    catalog.acceptDroppedFiles(event)
  }

  return (
    <aside
      ref={catalog.panelRef}
      className={styles.panel}
      aria-label="输入目录"
      aria-busy={catalog.busy}
      data-testid="input-catalog"
      tabIndex={0}
      onMouseDown={() => catalog.panelRef.current?.focus()}
      onDragEnter={handleDragEnter}
      onDragOver={(event) => {
        if (!isExternalFileDrag(event) || catalog.busy) return
        catalog.allowExternalDrop(event)
        if (!dropActive) setDropActive(true)
      }}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onContextMenu={(event) => {
        // 文档编辑器等内容通过 Portal 渲染到 body，React 事件仍会冒泡到本面板；
        // 只接管真正落在文件区 DOM 内的右键，避免文件菜单覆盖文档自己的浮层。
        if (!event.currentTarget.contains(event.target as Node)) return
        event.preventDefault()
        catalog.openBlankMenu(event)
      }}
    >
      {catalog.busy ? <span className={styles.busyBar} aria-hidden="true" /> : null}

      <InputCatalogHeader status={catalog.status} error={catalog.refreshError ?? catalog.error} />

      {catalog.status === 'ready' ? (
        <>
          <InputCatalogFilterBar
            query={catalog.query}
            group={catalog.group}
            type={catalog.type}
            onQuery={catalog.setQuery}
            onGroup={catalog.setGroup}
            onType={catalog.setType}
          />
          {catalog.searching ? null : (
            <InputCatalogBreadcrumbs
              folders={catalog.breadcrumbs}
              currentFolderId={catalog.currentFolderId}
              onOpen={catalog.openFolder}
            />
          )}
        </>
      ) : null}

      {clipboard ? (
        <p
          ref={clipRef}
          className={clsx(styles.clipBanner, clipboard.mode === 'cut' && styles.clipBannerCut)}
          role="status"
          data-testid="catalog-clipboard"
        >
          <span className={styles.clipIcon} aria-hidden="true">
            <ClipIcon />
          </span>
          <span className={styles.clipCopy}>
            <strong>
              {clipboard.mode === 'cut' ? '已剪切' : '已复制'}
              {clipboard.kind === 'folder' ? '文件夹' : '文件'}「{clipboardName}」
            </strong>
            <small>在当前目录粘贴，或右键目标文件夹粘贴。</small>
          </span>
          <button
            type="button"
            className={styles.clipClose}
            aria-label="取消剪贴板操作"
            onClick={catalog.clearClipboard}
          >
            <CloseIcon />
          </button>
        </p>
      ) : null}

      {catalog.refreshError ? (
        <p className={styles.banner} role="alert">
          <WarningDotIcon />
          <span>{catalog.refreshError.msg}</span>
          <button type="button" className={styles.bannerAction} onClick={onRefresh}>
            重试读取
          </button>
        </p>
      ) : null}

      {catalog.status === 'loading' ? <CatalogLoadingState /> : null}

      {catalog.status === 'failed' && catalog.error ? (
        <InputCatalogFailureState error={catalog.error} onRetry={onRefresh} />
      ) : null}

      {catalog.status === 'empty' ? (
        <InputCatalogEmptyState
          onImport={() => void catalog.importFiles()}
          onCreateFolder={() => catalog.beginCreateFolder(null)}
        />
      ) : null}

      {catalog.status === 'ready' ? (
        <InputFolderTree
          entries={catalog.entries}
          folders={catalog.folders}
          sources={catalog.sources}
          currentFolderId={catalog.currentFolderId}
          query={catalog.query}
          group={catalog.group}
          type={catalog.type}
          searching={catalog.searching}
          clipboard={clipboard}
          menu={menu}
          onOpenFolder={(folderId) => catalog.openFolder(folderId)}
          onOpenSource={catalog.openSource}
          onUseOnCanvas={catalog.useOnCanvas}
          onDragStart={catalog.beginSourceDrag}
          onFileMenu={catalog.openFileMenu}
          onFolderMenu={catalog.openFolderMenu}
          onBlankMenu={catalog.openBlankMenu}
          onDropIntoFolder={(event, folderId) => catalog.acceptDroppedFiles(event, folderId)}
          onAllowDrop={catalog.allowExternalDrop}
          onClearFilters={() => {
            catalog.setQuery('')
            catalog.setGroup('all')
            catalog.setType('all')
          }}
          onImport={() => void catalog.importFiles()}
          onCreateFolder={() => catalog.beginCreateFolder(catalog.currentFolderId)}
        />
      ) : null}

      {catalog.status === 'idle' ? (
        <p className={styles.idleState}>等待打开工程后读取输入来源。</p>
      ) : null}

      <div ref={overlayRef} className={styles.dropOverlay} aria-hidden="true">
        <div className={styles.dropCard}>
          <span className={styles.dropIcon}>
            <ImportIcon />
          </span>
          <strong>松开以导入文件</strong>
          <span>加入当前文件夹，或拖到文件夹行。</span>
        </div>
      </div>

      {catalog.status === 'ready' ? (
        <footer className={styles.footer}>
          <div className={styles.footerActions}>
            <Button
              className={styles.footerSecondary}
              variant="secondary"
              disabled={catalog.busy}
              onClick={() => catalog.beginCreateFolder(catalog.currentFolderId)}
            >
              <FolderPlusIcon />
              新建文件夹
            </Button>
            <Button
              className={styles.footerSecondary}
              variant="secondary"
              disabled={catalog.busy}
              onClick={() => catalog.beginCreateMaterial(catalog.currentFolderId)}
            >
              <SparkIcon />
              新建素材
            </Button>
            <Button
              className={styles.importButton}
              disabled={catalog.busy}
              onClick={() => void catalog.importFiles()}
            >
              <ImportIcon />
              导入文件
            </Button>
          </div>
        </footer>
      ) : null}

      {catalog.emptyDocument ? (
        <EmptyDocumentEditor
          parentFolderId={catalog.emptyDocument.parentFolderId}
          busy={catalog.busy}
          onClose={catalog.closeEmptyDocument}
          onSave={catalog.saveEmptyDocument}
        />
      ) : null}

      <InputSourceContextMenu
        menu={menu}
        targetName={menuTargetName}
        targetMeta={menuTargetMeta}
        useOnCanvasEnabled={Boolean(menuSource?.readable)}
        pasteEnabled={catalog.pasteEnabled}
        busy={catalog.busy}
        onUseOnCanvas={() => {
          if (menu?.kind === 'file') catalog.useOnCanvas(menu.sourceId)
        }}
        onCut={() => {
          if (menu?.kind === 'file') catalog.cutFile(menu.sourceId)
        }}
        onCopyFile={() => {
          if (menu?.kind === 'file') catalog.copyFile(menu.sourceId)
        }}
        onRenameFile={() => {
          if (menu?.kind === 'file') catalog.beginRenameFile(menu.sourceId)
        }}
        onDeleteFile={() => {
          if (menu?.kind === 'file') catalog.beginDeleteFile(menu.sourceId)
        }}
        onOpen={() => {
          if (menu?.kind !== 'file') return
          catalog.closeMenu()
          void catalog.openSource(menu.sourceId)
        }}
        onCreateMaterial={() => {
          if (menu?.kind === 'folder') catalog.beginCreateMaterial(menu.folderId)
          else catalog.beginCreateMaterial(catalog.currentFolderId)
        }}
        onCreateFolder={() => {
          if (menu?.kind === 'folder') catalog.beginCreateFolder(menu.folderId)
          else catalog.beginCreateFolder(catalog.currentFolderId)
        }}
        onPaste={() => {
          if (menu?.kind === 'folder') void catalog.pasteHere(menu.folderId)
          else void catalog.pasteHere(catalog.currentFolderId)
        }}
        onCopyFolder={() => {
          if (menu?.kind === 'folder') catalog.copyFolder(menu.folderId)
        }}
        onRenameFolder={() => {
          if (menu?.kind === 'folder') catalog.beginRenameFolder(menu.folderId)
        }}
        onDeleteFolder={() => {
          if (menu?.kind === 'folder') catalog.beginDeleteFolder(menu.folderId)
        }}
        onImport={() => {
          catalog.closeMenu()
          void catalog.importFiles()
        }}
        onClose={catalog.closeMenu}
      />

      <CatalogCreateDialog
        open={catalog.createChooserOpen}
        busy={catalog.busy}
        onClose={catalog.closeCreateChooser}
        onChooseDocument={catalog.chooseCreateDocument}
        onChooseMedia={catalog.chooseCreateMedia}
      />

      <CatalogNameDialogView
        dialog={catalog.nameDialog}
        busy={catalog.busy}
        onName={catalog.setNameDraft}
        onSubmit={() => void catalog.submitName()}
        onClose={catalog.closeNameDialog}
      />

      <CatalogDeleteFileDialog
        target={catalog.deleteTarget}
        busy={catalog.busy}
        onCancel={catalog.closeDeleteFile}
        onConfirm={() => void catalog.confirmDeleteFile()}
      />

      <CatalogDeleteFolderDialog
        plan={catalog.folderDeletionPlan}
        busy={catalog.busy}
        onCancel={catalog.closeDeleteFolder}
        onConfirm={() => void catalog.confirmDeleteFolder()}
      />
    </aside>
  )
}

function CatalogLoadingState(): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  useStateArtMotion(ref)
  return (
    <div ref={ref} className={styles.skeleton} role="status" aria-live="polite">
      <p className={styles.skeletonLabel}>正在读取工程来源…</p>
      {Array.from({ length: 5 }, (_, index) => (
        <span key={index} className={styles.skeletonRow}>
          <span className={styles.skeletonIcon} />
          <span className={styles.skeletonLines}>
            <span className={styles.skeletonLine} />
            <span className={styles.skeletonLineShort} />
          </span>
        </span>
      ))}
    </div>
  )
}
