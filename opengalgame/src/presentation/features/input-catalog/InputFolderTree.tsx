import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode
} from 'react'

import type { ProjectFolderVO } from '@application/project-files/vo/ProjectInputCatalogVO'
import type { ProjectInputSourceSummaryVO } from '@application/project-files/vo/ProjectInputSourceVO'
import { ImportIcon } from '../../pages/workbench/WorkbenchIcons'
import { SOURCE_DRAG_MIME } from '../workbench-session/workbenchSession.types'
import { FolderIcon, FolderPlusIcon, SearchNoResultIcon } from './InputCatalogIcons'
import { InputFolderRow, InputSourceRow } from './InputCatalogRows'
import { filterInputSources } from './inputCatalogFilters'
import { childFolders, childSources } from './inputCatalogTree'
import type {
  CatalogFolderId,
  CatalogGroup,
  CatalogMenuState,
  CatalogTreeEntry,
  CatalogTypeFilter
} from './inputCatalog.types'
import type { CatalogClipboard } from './useCatalogClipboard'
import {
  useCatalogRowsMotion,
  useFolderExpandMotion,
  useStateArtMotion
} from './useInputCatalogMotion'
import styles from './InputCatalogPanel.module.css'

interface InputFolderTreeProps {
  entries: readonly CatalogTreeEntry[]
  folders: readonly ProjectFolderVO[]
  sources: readonly ProjectInputSourceSummaryVO[]
  currentFolderId: CatalogFolderId
  query: string
  group: CatalogGroup
  type: CatalogTypeFilter
  searching: boolean
  clipboard: CatalogClipboard | null
  menu: CatalogMenuState
  onOpenFolder: (folderId: CatalogFolderId) => void
  onOpenSource: (sourceId: string) => void
  onUseOnCanvas: (sourceId: string) => void
  onDragStart: (event: DragEvent, source: ProjectInputSourceSummaryVO) => boolean
  onFileMenu: (
    event: { clientX: number; clientY: number },
    source: ProjectInputSourceSummaryVO
  ) => void
  onFolderMenu: (event: { clientX: number; clientY: number }, folderId: string) => void
  onBlankMenu: (event: { clientX: number; clientY: number }) => void
  onDropIntoFolder: (event: DragEvent, folderId: string) => void
  onAllowDrop: (event: DragEvent) => void
  onClearFilters: () => void
  onImport: () => void
  onCreateFolder: () => void
}

/** 当前目录的文件夹与来源树。子文件夹可原位展开，双击进入目录。 */
export function InputFolderTree(props: InputFolderTreeProps): ReactElement {
  return (
    <CatalogTreeBody
      key={`${props.currentFolderId ?? 'root'}:${props.searching ? 'search' : 'browse'}`}
      {...props}
    />
  )
}

function CatalogTreeBody({
  entries,
  folders,
  sources,
  query,
  group,
  type,
  searching,
  clipboard,
  menu,
  onOpenFolder,
  onOpenSource,
  onUseOnCanvas,
  onDragStart,
  onFileMenu,
  onFolderMenu,
  onBlankMenu,
  onDropIntoFolder,
  onAllowDrop,
  onClearFilters,
  onImport,
  onCreateFolder
}: InputFolderTreeProps): ReactElement {
  const scopeRef = useRef<HTMLDivElement>(null)
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set())
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropFolderId, setDropFolderId] = useState<string | null>(null)

  useEffect(() => {
    const clearDragState = (): void => {
      setDropFolderId(null)
      setDraggingId(null)
    }
    window.addEventListener('dragend', clearDragState, true)
    window.addEventListener('drop', clearDragState, true)
    return () => {
      window.removeEventListener('dragend', clearDragState, true)
      window.removeEventListener('drop', clearDragState, true)
    }
  }, [])

  const filteredSources = useMemo(
    () => filterInputSources(sources, '', group, type),
    [group, sources, type]
  )
  const signature = `${group}|${type}`
  useCatalogRowsMotion(scopeRef, signature)

  const activeSourceId = menu?.kind === 'file' ? menu.sourceId : null
  const activeFolderId = menu?.kind === 'folder' ? menu.folderId : null

  function toggleFolder(folderId: string): void {
    setExpandedIds((current) => {
      const next = new Set(current)
      if (next.has(folderId)) next.delete(folderId)
      else next.add(folderId)
      return next
    })
  }

  function sourceClipboardState(sourceId: string): { cut: boolean; copied: boolean } {
    return {
      cut:
        clipboard?.mode === 'cut' && clipboard.kind === 'file' && clipboard.sourceId === sourceId,
      copied:
        clipboard?.mode === 'copy' && clipboard.kind === 'file' && clipboard.sourceId === sourceId
    }
  }

  function startSourceDrag(event: DragEvent, source: ProjectInputSourceSummaryVO): void {
    const started = onDragStart(event, source)
    setDraggingId(started ? source.sourceId : null)
    if (!started) event.preventDefault()
  }

  function folderDropHandlers(folderId: string): {
    onDragOver: (event: DragEvent) => void
    onDragLeave: (event: DragEvent) => void
    onDrop: (event: DragEvent) => void
  } {
    return {
      onDragOver: (event) => {
        if (
          !event.dataTransfer.types.includes('Files') ||
          event.dataTransfer.types.includes(SOURCE_DRAG_MIME)
        )
          return
        onAllowDrop(event)
        event.stopPropagation()
        if (dropFolderId !== folderId) setDropFolderId(folderId)
      },
      onDragLeave: (event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        if (dropFolderId === folderId) setDropFolderId(null)
      },
      onDrop: (event) => {
        if (event.dataTransfer.types.includes(SOURCE_DRAG_MIME)) return
        event.stopPropagation()
        setDropFolderId(null)
        onDropIntoFolder(event, folderId)
      }
    }
  }

  function renderSource(
    source: ProjectInputSourceSummaryVO,
    depth: number,
    path: string | null
  ): ReactElement {
    const state = sourceClipboardState(source.sourceId)
    return (
      <li key={`source:${source.sourceId}`} className={styles.treeItem}>
        <InputSourceRow
          source={source}
          depth={depth}
          path={path}
          query={query}
          cut={state.cut}
          copied={state.copied}
          dragging={draggingId === source.sourceId}
          active={activeSourceId === source.sourceId}
          canUseOnCanvas
          onDragStart={(event) => startSourceDrag(event, source)}
          onDragEnd={() => setDraggingId(null)}
          onOpen={() => {
            if (source.readable) onOpenSource(source.sourceId)
          }}
          onUseOnCanvas={() => onUseOnCanvas(source.sourceId)}
          onMenu={(event) => onFileMenu(event, source)}
        />
      </li>
    )
  }

  function renderFolder(
    folder: ProjectFolderVO,
    depth: number,
    path: string | null,
    branch: ReadonlySet<string>
  ): ReactElement {
    const nestedFolders = childFolders(folders, folder.folderId)
    const nestedSources = childSources(filteredSources, folder.folderId)
    const totalChildren =
      childFolders(folders, folder.folderId).length + childSources(sources, folder.folderId).length
    const expanded = !searching && expandedIds.has(folder.folderId)
    const nextBranch = new Set(branch)
    nextBranch.add(folder.folderId)
    const dropHandlers = folderDropHandlers(folder.folderId)

    return (
      <li key={`folder:${folder.folderId}`} className={styles.treeItem}>
        <InputFolderRow
          folder={folder}
          depth={depth}
          path={path}
          childCount={totalChildren}
          expandable={!searching}
          expanded={expanded}
          active={activeFolderId === folder.folderId}
          dropTarget={dropFolderId === folder.folderId}
          onToggle={() => toggleFolder(folder.folderId)}
          onOpen={() => onOpenFolder(folder.folderId)}
          onMenu={(event) => onFolderMenu(event, folder.folderId)}
          onDragOver={dropHandlers.onDragOver}
          onDragLeave={dropHandlers.onDragLeave}
          onDrop={dropHandlers.onDrop}
        />
        {expanded && (nestedFolders.length > 0 || nestedSources.length > 0) ? (
          <FolderChildren>
            {nestedFolders.map((child) =>
              branch.has(child.folderId) ? null : renderFolder(child, depth + 1, null, nextBranch)
            )}
            {nestedSources.map((source) => renderSource(source, depth + 1, null))}
          </FolderChildren>
        ) : null}
        {expanded &&
        totalChildren > 0 &&
        nestedFolders.length === 0 &&
        nestedSources.length === 0 ? (
          <p className={styles.childrenEmpty}>当前筛选下没有匹配内容</p>
        ) : null}
      </li>
    )
  }

  return (
    <div className={styles.listArea} ref={scopeRef}>
      <div className={styles.sectionBar} data-catalog-animate="">
        {searching ? (
          <span className={styles.sectionLabel}>搜索结果</span>
        ) : (
          <span className={styles.sectionLabel}>当前来源</span>
        )}
        <span className={styles.sectionCount} aria-live="polite">
          {entries.length > 0 ? `${entries.length} 项` : '暂无内容'}
        </span>
        {searching || group !== 'all' || type !== 'all' ? (
          <button type="button" className={styles.sectionClear} onClick={onClearFilters}>
            清除筛选
          </button>
        ) : null}
      </div>

      <ul
        className={styles.list}
        data-testid="input-folder-tree"
        onContextMenu={(event) => {
          if (event.target !== event.currentTarget) return
          event.preventDefault()
          event.stopPropagation()
          onBlankMenu(event)
        }}
      >
        {entries.length === 0 ? (
          <li className={styles.listEmptyItem}>
            <CatalogListEmpty
              searching={searching || group !== 'all' || type !== 'all'}
              onClearFilters={onClearFilters}
              onImport={onImport}
              onCreateFolder={onCreateFolder}
              onContextMenu={(event) => {
                event.preventDefault()
                event.stopPropagation()
                onBlankMenu(event)
              }}
            />
          </li>
        ) : null}
        {entries.map((entry) =>
          entry.kind === 'folder'
            ? renderFolder(entry.folder, 0, searching ? entry.path : null, new Set())
            : renderSource(entry.source, 0, searching ? entry.path : null)
        )}
        <li
          className={styles.listPad}
          data-testid="catalog-blank-area"
          onContextMenu={(event) => {
            event.preventDefault()
            event.stopPropagation()
            onBlankMenu(event)
          }}
        />
      </ul>
    </div>
  )
}

function FolderChildren({ children }: { children: ReactNode }): ReactElement {
  const ref = useRef<HTMLUListElement>(null)
  useFolderExpandMotion(ref)
  return (
    <ul ref={ref} className={styles.children} role="group">
      {children}
    </ul>
  )
}

function CatalogListEmpty({
  searching,
  onClearFilters,
  onImport,
  onCreateFolder,
  onContextMenu
}: {
  searching: boolean
  onClearFilters: () => void
  onImport: () => void
  onCreateFolder: () => void
  onContextMenu: (event: MouseEvent) => void
}): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  useStateArtMotion(ref)

  if (searching) {
    return (
      <div
        ref={ref}
        className={styles.filterEmpty}
        data-testid="catalog-filter-empty"
        onContextMenu={onContextMenu}
      >
        <span className={styles.filterEmptyIcon} data-state-art="" aria-hidden="true">
          <SearchNoResultIcon />
        </span>
        <p className={styles.filterEmptyTitle} data-state-art="">
          没有匹配的来源或文件夹
        </p>
        <p className={styles.filterEmptyHint}>换一个名称，或恢复来源分组与类型筛选。</p>
        <button type="button" className={styles.textButton} onClick={onClearFilters}>
          清除全部筛选
        </button>
      </div>
    )
  }
  return (
    <div
      ref={ref}
      className={styles.folderEmpty}
      data-testid="catalog-folder-empty"
      onContextMenu={onContextMenu}
    >
      <span className={styles.folderEmptyIcon} data-state-art="" aria-hidden="true">
        <FolderIcon />
        <span className={styles.folderEmptyPlus} aria-hidden="true">
          +
        </span>
      </span>
      <p className={styles.folderEmptyTitle} data-state-art="">
        这个文件夹还是空的
      </p>
      <p className={styles.folderEmptyHint}>把文件拖进当前文件夹，或从导入开始整理本场景的输入。</p>
      <div className={styles.folderEmptyActions}>
        <button type="button" className={styles.textButton} onClick={onImport}>
          <ImportIcon />
          导入文件
        </button>
        <button type="button" className={styles.textButton} onClick={onCreateFolder}>
          <FolderPlusIcon />
          新建文件夹
        </button>
      </div>
    </div>
  )
}
