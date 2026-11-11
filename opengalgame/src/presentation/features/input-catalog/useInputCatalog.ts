import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { toast } from 'sonner'

import type {
  ProjectFolderDeletionPlanVO,
  ProjectFolderVO,
  ProjectInputCatalogVO
} from '@application/project-files/vo/ProjectInputCatalogVO'
import type { ProjectInputSourceSummaryVO } from '@application/project-files/vo/ProjectInputSourceVO'
import type { ProjectFilesClient } from '@interfaces/project-files/client/ProjectFilesClient'
import { failureOf, requireSuccess } from '../../feedback/failure'
import { workbenchFeedback } from '../../feedback/workbenchFeedback'
import { filterInputSources } from './inputCatalogFilters'
import { useWorkbenchSessionStore } from '../workbench-session/workbenchSession.store'
import {
  SOURCE_DRAG_MIME,
  type InputSourceDragPayload,
  type WorkspaceLoadStatus
} from '../workbench-session/workbenchSession.types'
import {
  catalogVersion,
  projectInputSourcesQueryKey,
  reloadCatalog,
  stillCurrentProject
} from './catalogSession'
import {
  beginCatalogWrite,
  chooseAndImport,
  confirmFolderDeletion,
  deleteSourceFile,
  endCatalogWrite,
  importDroppedFiles,
  loadFolderDeletionPlan,
  openSourceFile,
  placeSourceOnCanvas,
  catalogWriteBlockedFor,
  settleUnresolvedCatalogWrite,
  submitCatalogName
} from './catalogWrites'
import type {
  CatalogFolderId,
  CatalogGroup,
  CatalogMenuState,
  CatalogNameDialog,
  CatalogTypeFilter,
  UseInputCatalog
} from './inputCatalog.types'
import { catalogShortcutAction } from './inputCatalogShortcuts'
import {
  breadcrumbFolders,
  currentFolderEntries,
  pruneFolderTrail,
  searchCatalogEntries
} from './inputCatalogTree'
import { useCatalogClipboard } from './useCatalogClipboard'

export type { CatalogMenuState, UseInputCatalog } from './inputCatalog.types'
export { fetchProjectInputSources, projectInputSourcesQueryKey } from './catalogSession'
export { importDroppedFiles } from './catalogWrites'

const emptyFolders: readonly ProjectFolderVO[] = []
const emptySources: readonly ProjectInputSourceSummaryVO[] = []

export function useInputCatalog(client: ProjectFilesClient): UseInputCatalog {
  const projectId = useWorkbenchSessionStore((state) => state.projectId)
  const queryClient = useQueryClient()
  const panelRef = useRef<HTMLElement | null>(null)
  const [query, setQuery] = useState('')
  const [group, setGroup] = useState<CatalogGroup>('all')
  const [type, setType] = useState<CatalogTypeFilter>('all')
  const [busy, setBusy] = useState(false)
  const seenProjectId = useRef<string | null>(null)
  const [folderTrail, setFolderTrail] = useState<string[]>([])
  const [menu, setMenu] = useState<CatalogMenuState>(null)
  const [nameDialog, setNameDialog] = useState<CatalogNameDialog>(null)
  const [createChooser, setCreateChooser] = useState<CatalogFolderId | false>(false)
  const [emptyDocument, setEmptyDocument] = useState<{ parentFolderId: CatalogFolderId } | null>(
    null
  )
  const [deleteTarget, setDeleteTarget] = useState<ProjectInputSourceSummaryVO | null>(null)
  const [folderDeletionPlan, setFolderDeletionPlan] = useState<ProjectFolderDeletionPlanVO | null>(
    null
  )

  const listQuery = useQuery({
    queryKey: projectInputSourcesQueryKey(projectId),
    queryFn: async (): Promise<ProjectInputCatalogVO> =>
      requireSuccess(await client.listProjectInputSources({ projectId })),
    enabled: projectId.length > 0
  })

  const folders = listQuery.data?.folders ?? emptyFolders
  const sources = listQuery.data?.sources ?? emptySources
  const currentFolderId = folderTrail[folderTrail.length - 1] ?? null
  const clipboardApi = useCatalogClipboard(projectId, folders, sources)

  useEffect(() => {
    setFolderTrail((trail) => pruneFolderTrail(folders, trail))
  }, [folders])

  useEffect(() => {
    if (seenProjectId.current !== null && seenProjectId.current !== projectId) {
      setEmptyDocument(null)
    }
    seenProjectId.current = projectId
    setBusy(catalogWriteBlockedFor(projectId))
    void settleUnresolvedCatalogWrite(client, projectId, setBusy)
    setQuery('')
    setGroup('all')
    setType('all')
    setFolderTrail([])
    setMenu(null)
    setNameDialog(null)
    setCreateChooser(false)
    setDeleteTarget(null)
    setFolderDeletionPlan(null)
  }, [projectId])

  const searching = query.trim().length > 0
  const typedSources = useMemo(
    () => filterInputSources(sources, '', group, type),
    [sources, group, type]
  )
  const entries = useMemo(
    () =>
      searching
        ? searchCatalogEntries(folders, sources, query, group, type)
        : currentFolderEntries(folders, typedSources, currentFolderId),
    [currentFolderId, folders, group, query, searching, sources, type, typedSources]
  )
  const breadcrumbs = useMemo(
    () => breadcrumbFolders(folders, currentFolderId),
    [currentFolderId, folders]
  )
  const status: WorkspaceLoadStatus =
    projectId.length === 0
      ? 'idle'
      : listQuery.isPending && !listQuery.data
        ? 'loading'
        : listQuery.isError && !listQuery.data
          ? 'failed'
          : folders.length === 0 && sources.length === 0
            ? 'empty'
            : 'ready'
  const error = listQuery.isError && !listQuery.data ? failureOf(listQuery.error) : null
  const refreshError = listQuery.isError && listQuery.data ? failureOf(listQuery.error) : null
  const pasteTarget = menu?.kind === 'folder' ? menu.folderId : currentFolderId
  const pasteEnabled = clipboardApi.canPasteInto(pasteTarget)

  useEffect(() => {
    /** 文件区快捷键：复制、剪切、粘贴；无菜单和对话框时 Escape 取消剪切。 */
    function onKey(event: KeyboardEvent): void {
      const target = event.target
      const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
      if (
        typing ||
        nameDialog ||
        createChooser !== false ||
        emptyDocument ||
        deleteTarget ||
        folderDeletionPlan
      ) {
        return
      }
      if (event.key === 'Escape') {
        if (menu) {
          setMenu(null)
          return
        }
        if (clipboardApi.clipboard?.mode === 'cut') {
          clipboardApi.clearClipboard()
          event.preventDefault()
        }
        return
      }
      const focused = document.activeElement
      if (focused !== panelRef.current && !panelRef.current?.contains(focused)) return
      if (!(event.ctrlKey || event.metaKey)) return
      const action = catalogShortcutAction(event.key, menu?.kind ?? null)
      if (action === 'ignore') return
      event.preventDefault()
      if (action === 'copy-file' && menu?.kind === 'file') {
        clipboardApi.copyFile(menu.sourceId)
        setMenu(null)
      } else if (action === 'cut-file' && menu?.kind === 'file') {
        clipboardApi.cutFile(menu.sourceId)
        setMenu(null)
      } else if (action === 'paste-current') {
        void clipboardApi.pasteInto(client, queryClient, currentFolderId, busy, setBusy)
        setMenu(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    busy,
    clipboardApi,
    client,
    createChooser,
    currentFolderId,
    emptyDocument,
    deleteTarget,
    folderDeletionPlan,
    menu,
    nameDialog,
    queryClient
  ])

  return {
    panelRef,
    query,
    group,
    type,
    folders,
    sources,
    currentFolderId,
    breadcrumbs,
    entries,
    searching,
    status,
    error,
    refreshError,
    busy,
    menu,
    nameDialog,
    createChooserOpen: createChooser !== false,
    deleteTarget,
    folderDeletionPlan,
    clipboard: clipboardApi.clipboard,
    pasteEnabled,
    clearClipboard: clipboardApi.clearClipboard,
    setQuery,
    setGroup,
    setType,
    openFolder: (folderId) => {
      setQuery('')
      if (folderId === null) {
        setFolderTrail([])
        return
      }
      setFolderTrail(breadcrumbFolders(folders, folderId).map((folder) => folder.folderId))
    },
    beginSourceDrag: (event, source) => {
      if (!source.readable || projectId.length === 0) {
        event.preventDefault()
        return false
      }
      const payload: InputSourceDragPayload = { projectId, sourceId: source.sourceId }
      event.dataTransfer.setData(SOURCE_DRAG_MIME, JSON.stringify(payload))
      event.dataTransfer.effectAllowed = 'copy'
      return true
    },
    openFileMenu: (event, source) => {
      setMenu({ kind: 'file', x: event.clientX, y: event.clientY, sourceId: source.sourceId })
    },
    openFolderMenu: (event, folderId) => {
      setMenu({ kind: 'folder', x: event.clientX, y: event.clientY, folderId })
    },
    openBlankMenu: (event) => {
      setMenu({ kind: 'blank', x: event.clientX, y: event.clientY })
    },
    closeMenu: () => setMenu(null),
    importFiles: () =>
      chooseAndImport(client, queryClient, projectId, currentFolderId, busy, setBusy),
    allowExternalDrop: (event) => {
      if (isInternalSourceDrag(event) || !hasFilePayload(event) || busy) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    },
    acceptDroppedFiles: (event, parentFolderId = currentFolderId) => {
      if (isInternalSourceDrag(event) || busy) return
      event.preventDefault()
      void importDroppedFiles(
        client,
        queryClient,
        projectId,
        parentFolderId,
        event.dataTransfer.files,
        busy,
        setBusy
      )
    },
    useOnCanvas: (sourceId) => {
      setMenu(null)
      placeSourceOnCanvas(sourceId)
    },
    openSource: (sourceId) => openSourceFile(client, projectId, sourceId),
    copyFile: (sourceId) => {
      setMenu(null)
      clipboardApi.copyFile(sourceId)
    },
    cutFile: (sourceId) => {
      setMenu(null)
      clipboardApi.cutFile(sourceId)
    },
    copyFolder: (folderId) => {
      setMenu(null)
      clipboardApi.copyFolder(folderId)
    },
    pasteHere: (targetFolderId) => {
      setMenu(null)
      return clipboardApi.pasteInto(client, queryClient, targetFolderId, busy, setBusy)
    },
    beginCreateFolder: (parentFolderId) => {
      setMenu(null)
      setNameDialog({ kind: 'create-folder', parentFolderId, name: '', error: null })
    },
    beginCreateMaterial: (parentFolderId) => {
      setMenu(null)
      setCreateChooser(parentFolderId)
    },
    closeCreateChooser: () => {
      if (!busy) setCreateChooser(false)
    },
    emptyDocument,
    closeEmptyDocument: () => {
      if (!busy) setEmptyDocument(null)
    },
    saveEmptyDocument: async (draft) => {
      if (!emptyDocument) return
      if (!beginCatalogWrite(projectId, busy, setBusy)) return
      try {
        requireSuccess(
          await client.createProjectTextFile({
            projectId,
            parentFolderId: emptyDocument.parentFolderId,
            expectedCatalogVersion: catalogVersion(queryClient, projectId),
            fileName: draft.fileName,
            content: draft.content
          })
        )
        if (!stillCurrentProject(projectId)) return
        toast(workbenchFeedback.documentCreated)
        setEmptyDocument(null)
      } catch (error) {
        if (!stillCurrentProject(projectId)) return
        toast(failureOf(error).msg)
      } finally {
        if (stillCurrentProject(projectId)) {
          await reloadCatalog(client, queryClient, projectId)
        }
        endCatalogWrite(projectId, setBusy)
      }
    },
    chooseCreateDocument: () => {
      const parent = createChooser === false ? currentFolderId : createChooser
      setCreateChooser(false)
      setMenu(null)
      useWorkbenchSessionStore.getState().closeDocumentLayer()
      setEmptyDocument({ parentFolderId: parent })
    },
    chooseCreateMedia: () => {
      const parent = createChooser === false ? currentFolderId : createChooser
      setCreateChooser(false)
      void chooseAndImport(client, queryClient, projectId, parent, busy, setBusy)
    },
    beginRenameFile: (sourceId) => {
      const source = sources.find((item) => item.sourceId === sourceId)
      if (!source) return
      setMenu(null)
      setNameDialog({ kind: 'rename-file', sourceId, name: source.name, error: null })
    },
    beginRenameFolder: (folderId) => {
      const folder = folders.find((item) => item.folderId === folderId)
      if (!folder) return
      setMenu(null)
      setNameDialog({ kind: 'rename-folder', folderId, name: folder.name, error: null })
    },
    setNameDraft: (name) => {
      setNameDialog((current) => (current ? { ...current, name, error: null } : current))
    },
    submitName: () =>
      submitCatalogName(client, queryClient, projectId, nameDialog, busy, setBusy, setNameDialog),
    closeNameDialog: () => {
      if (!busy) setNameDialog(null)
    },
    beginDeleteFile: (sourceId) => {
      const source = sources.find((item) => item.sourceId === sourceId)
      if (!source) return
      setMenu(null)
      setDeleteTarget(source)
    },
    confirmDeleteFile: () =>
      deleteSourceFile(
        client,
        queryClient,
        projectId,
        deleteTarget,
        busy,
        setBusy,
        setDeleteTarget
      ),
    closeDeleteFile: () => {
      if (!busy) setDeleteTarget(null)
    },
    beginDeleteFolder: (folderId) => {
      setMenu(null)
      void loadFolderDeletionPlan(client, projectId, folderId, busy, setBusy, setFolderDeletionPlan)
    },
    confirmDeleteFolder: () =>
      confirmFolderDeletion(
        client,
        queryClient,
        projectId,
        folderDeletionPlan,
        busy,
        setBusy,
        setFolderDeletionPlan
      ),
    closeDeleteFolder: () => {
      if (!busy) setFolderDeletionPlan(null)
    }
  }
}

function isInternalSourceDrag(event: DragEvent): boolean {
  return event.dataTransfer.types.includes(SOURCE_DRAG_MIME)
}

function hasFilePayload(event: DragEvent): boolean {
  return event.dataTransfer.types.includes('Files')
}
