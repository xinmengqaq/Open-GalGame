import { clsx } from 'clsx'
import { useState, type DragEvent, type ReactElement } from 'react'

import type { ProjectFolderVO } from '@application/project-files/vo/ProjectInputCatalogVO'
import type { ProjectInputSourceSummaryVO } from '@application/project-files/vo/ProjectInputSourceVO'
import { MediaPreview } from '../media-preview/MediaPreview'
import { formatMediaTime } from '../media-preview/mediaPresentation'
import { ContentKindIcon } from '../workbench-session/ContentKindIcon'
import { contentKindLabel } from '../workbench-session/contentKindLabel'
import { ChevronIcon, FolderIcon, MoreIcon, PlusIcon } from './InputCatalogIcons'
import { InputCatalogSourceStatus } from './InputCatalogSourceStatus'
import styles from './InputCatalogPanel.module.css'

interface FolderRowProps {
  folder: ProjectFolderVO
  depth: number
  path: string | null
  childCount: number
  expandable: boolean
  expanded: boolean
  active: boolean
  dropTarget: boolean
  onToggle: () => void
  onOpen: () => void
  onMenu: (event: { clientX: number; clientY: number }) => void
  onDragOver: (event: DragEvent) => void
  onDragLeave: (event: DragEvent) => void
  onDrop: (event: DragEvent) => void
}

export function InputFolderRow({
  folder,
  depth,
  path,
  childCount,
  expandable,
  expanded,
  active,
  dropTarget,
  onToggle,
  onOpen,
  onMenu,
  onDragOver,
  onDragLeave,
  onDrop
}: FolderRowProps): ReactElement {
  return (
    <div
      className={clsx(styles.row, styles.folderRow, dropTarget && styles.rowDropTarget)}
      data-catalog-animate=""
      data-catalog-row=""
      data-menu-active={active ? 'true' : undefined}
      data-depth={depth}
      data-testid="input-folder-row"
      data-folder-id={folder.folderId}
      onDoubleClick={onOpen}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onMenu(event)
      }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <span className={styles.guide} aria-hidden="true" />
      {expandable ? (
        <button
          type="button"
          className={styles.chevron}
          aria-label={`${expanded ? '收起' : '展开'}文件夹 ${folder.name}`}
          aria-expanded={expanded}
          onClick={(event) => {
            event.stopPropagation()
            onToggle()
          }}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <ChevronIcon />
        </button>
      ) : (
        <span className={styles.chevronSpacer} aria-hidden="true" />
      )}
      <span className={styles.iconTile} data-tone="folder" aria-hidden="true">
        <FolderIcon open={expanded} />
      </span>
      <span
        className={styles.rowMain}
        role="button"
        tabIndex={0}
        aria-label={`文件夹 ${folder.name}`}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            onOpen()
          } else if (event.key === 'ArrowRight' && !expanded) {
            event.preventDefault()
            onToggle()
          } else if (event.key === 'ArrowLeft' && expanded) {
            event.preventDefault()
            onToggle()
          }
        }}
      >
        <span className={styles.rowName} title={folder.name}>
          {folder.name}
        </span>
        <span className={styles.rowMeta}>
          <span className={styles.kindTag} data-kind="folder">
            <span className={styles.kindDot} aria-hidden="true" />
            文件夹
          </span>
          <span className={styles.metaDot} aria-hidden="true" />
          <span>{childCount > 0 ? `${childCount} 项` : '空目录'}</span>
          {path ? (
            <span className={styles.path} title={path}>
              {path}
            </span>
          ) : null}
        </span>
      </span>
      <span className={styles.rowActions}>
        <button
          type="button"
          className={styles.rowAction}
          aria-label={`打开文件夹 ${folder.name}`}
          title="打开文件夹"
          onClick={(event) => {
            event.stopPropagation()
            onOpen()
          }}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <ChevronIcon />
        </button>
        <button
          type="button"
          className={styles.rowAction}
          aria-label="文件夹操作"
          title="文件夹操作"
          onClick={(event) => {
            event.stopPropagation()
            const rect = event.currentTarget.getBoundingClientRect()
            onMenu({ clientX: rect.right, clientY: rect.bottom + 4 })
          }}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <MoreIcon />
        </button>
      </span>
    </div>
  )
}

interface SourceRowProps {
  source: ProjectInputSourceSummaryVO
  depth: number
  path: string | null
  query: string
  cut: boolean
  copied: boolean
  dragging: boolean
  active: boolean
  canUseOnCanvas: boolean
  onDragStart: (event: DragEvent) => void
  onDragEnd: () => void
  onOpen: () => void
  onUseOnCanvas: () => void
  onMenu: (event: { clientX: number; clientY: number }) => void
}

export function InputSourceRow({
  source,
  depth,
  path,
  query,
  cut,
  copied,
  dragging,
  active,
  canUseOnCanvas,
  onDragStart,
  onDragEnd,
  onOpen,
  onUseOnCanvas,
  onMenu
}: SourceRowProps): ReactElement {
  const textKind = source.contentKind === 'text' ? source.textKind : undefined
  const kind = contentKindLabel(source.contentKind, textKind)
  const [mediaDuration, setMediaDuration] = useState(0)
  const rowTitle = source.readable
    ? '拖入画布，或双击用系统程序打开'
    : '来源不可读取，不能添加到画布'

  return (
    <div
      className={clsx(
        styles.row,
        !source.readable && styles.rowDisabled,
        cut && styles.rowCut,
        copied && styles.rowCopied,
        dragging && styles.rowDragging
      )}
      data-catalog-animate=""
      data-catalog-row=""
      data-menu-active={active ? 'true' : undefined}
      data-depth={depth}
      data-testid="input-source-row"
      data-source-id={source.sourceId}
      data-content-kind={source.contentKind}
      data-text-kind={textKind}
      data-readable={source.readable ? 'true' : 'false'}
      data-cut={cut ? 'true' : undefined}
      data-dragging={dragging ? 'true' : undefined}
      draggable={source.readable}
      title={rowTitle}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDoubleClick={onOpen}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
        onMenu(event)
      }}
    >
      <span className={styles.guide} aria-hidden="true" />
      <span className={styles.chevronSpacer} aria-hidden="true" />
      {source.contentKind === 'text' ? (
        <span className={styles.iconTile} data-tone={textKind} aria-hidden="true">
          <ContentKindIcon contentKind="text" textKind={textKind} />
        </span>
      ) : (
        <span
          className={styles.mediaTile}
          data-tone={source.contentKind}
          data-media-state={source.readable ? 'ready' : 'blocked'}
        >
          {source.readable ? (
            <MediaPreview
              sourceId={source.sourceId}
              kind={source.contentKind}
              title={source.name}
              variant="thumbnail"
              lazy
              onDuration={source.contentKind === 'audio' ? setMediaDuration : undefined}
            />
          ) : (
            <ContentKindIcon contentKind={source.contentKind} />
          )}
        </span>
      )}
      <span
        className={styles.rowMain}
        role="button"
        tabIndex={0}
        aria-label={`${kind} ${source.name}${source.readable ? '' : '，不可读取'}`}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            onOpen()
          }
        }}
      >
        <span className={styles.rowName} title={source.name}>
          <HighlightedName name={source.name} query={query} />
        </span>
        <span className={styles.rowMeta}>
          <span className={styles.kindTag} data-kind={textKind ?? source.contentKind}>
            <span className={styles.kindDot} aria-hidden="true" />
            {kind}
          </span>
          {mediaDuration > 0 ? (
            <>
              <span className={styles.metaDot} aria-hidden="true" />
              <span className={styles.mediaDuration}>{formatMediaTime(mediaDuration)}</span>
            </>
          ) : null}
          {!source.readable ? (
            <>
              <span className={styles.metaDot} aria-hidden="true" />
              <InputCatalogSourceStatus readable={false} />
            </>
          ) : null}
          {cut ? (
            <>
              <span className={styles.metaDot} aria-hidden="true" />
              <span className={styles.metaWarn}>剪切中</span>
            </>
          ) : null}
          {copied ? (
            <>
              <span className={styles.metaDot} aria-hidden="true" />
              <span className={styles.metaCopied}>已复制</span>
            </>
          ) : null}
          {path ? (
            <span className={styles.path} title={path}>
              {path}
            </span>
          ) : null}
        </span>
      </span>
      <span className={styles.rowActions}>
        <button
          type="button"
          className={styles.rowAction}
          aria-label={`将 ${source.name} 添加到画布`}
          title={source.readable ? '添加到画布' : '来源不可读取，不能添加到画布'}
          disabled={!source.readable || !canUseOnCanvas}
          onClick={(event) => {
            event.stopPropagation()
            onUseOnCanvas()
          }}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <PlusIcon />
        </button>
        <button
          type="button"
          className={styles.rowAction}
          aria-label="文件操作"
          title="文件操作"
          onClick={(event) => {
            event.stopPropagation()
            const rect = event.currentTarget.getBoundingClientRect()
            onMenu({ clientX: rect.right, clientY: rect.bottom + 4 })
          }}
          onDoubleClick={(event) => event.stopPropagation()}
        >
          <MoreIcon />
        </button>
      </span>
    </div>
  )
}

function HighlightedName({ name, query }: { name: string; query: string }): ReactElement {
  const needle = query.trim()
  if (needle.length === 0) return <>{name}</>
  const index = name.toLowerCase().indexOf(needle.toLowerCase())
  if (index < 0) return <>{name}</>
  return (
    <>
      {name.slice(0, index)}
      <mark className={styles.mark}>{name.slice(index, index + needle.length)}</mark>
      {name.slice(index + needle.length)}
    </>
  )
}
