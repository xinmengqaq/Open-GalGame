import type { DragEvent } from 'react'

import type {
  ProjectFolderDeletionPlanVO,
  ProjectFolderVO
} from '@application/project-files/vo/ProjectInputCatalogVO'
import type {
  ProjectFileAssetKind,
  ProjectInputSourceSummaryVO
} from '@application/project-files/vo/ProjectInputSourceVO'
import type { FailureState } from '../../feedback/failure'
import type { ImportedSourceAction } from '../workbench-session/workbenchActionObservers'
import type { WorkspaceLoadStatus } from '../workbench-session/workbenchSession.types'
import type { CatalogClipboard } from './useCatalogClipboard'

export type CatalogGroup = 'all' | 'text' | 'asset'

export type CatalogTypeFilter = 'all' | 'document' | ProjectFileAssetKind

export type CatalogFolderId = string | null

export type CatalogImportOptions = {
  mediaKinds?: readonly ProjectFileAssetKind[]
}

/** 本次导入回执：保留通用来源身份，并带上文件区候选规则派生的素材类别。 */
export type CatalogImportedSource = ImportedSourceAction & {
  candidateKind: ProjectFileAssetKind | null
}

export type CatalogImportOutcome =
  | { status: 'cancelled' }
  | { status: 'imported'; sources: readonly CatalogImportedSource[] }
  | { status: 'none' }
  | { status: 'unconfirmed' }
  | { status: 'failed' }
  | { status: 'not-started' }

export type CatalogMenuState =
  | { kind: 'file'; x: number; y: number; sourceId: string }
  | { kind: 'folder'; x: number; y: number; folderId: string }
  | { kind: 'blank'; x: number; y: number }
  | null

export type CatalogNameDialog =
  | { kind: 'create-folder'; parentFolderId: CatalogFolderId; name: string; error: string | null }
  | { kind: 'rename-file'; sourceId: string; name: string; error: string | null }
  | { kind: 'rename-folder'; folderId: string; name: string; error: string | null }
  | null

export type CatalogTreeEntry =
  | { kind: 'folder'; folder: ProjectFolderVO; path: string }
  | { kind: 'source'; source: ProjectInputSourceSummaryVO; path: string }

export interface UseInputCatalog {
  query: string
  group: CatalogGroup
  type: CatalogTypeFilter
  folders: readonly ProjectFolderVO[]
  sources: readonly ProjectInputSourceSummaryVO[]
  currentFolderId: CatalogFolderId
  breadcrumbs: readonly ProjectFolderVO[]
  entries: CatalogTreeEntry[]
  searching: boolean
  status: WorkspaceLoadStatus
  error: FailureState | null
  refreshError: FailureState | null
  busy: boolean
  menu: CatalogMenuState
  nameDialog: CatalogNameDialog
  createChooserOpen: boolean
  deleteTarget: ProjectInputSourceSummaryVO | null
  folderDeletionPlan: ProjectFolderDeletionPlanVO | null
  clipboard: CatalogClipboard | null
  pasteEnabled: boolean
  clearClipboard: () => void
  setQuery: (value: string) => void
  setGroup: (value: CatalogGroup) => void
  setType: (value: CatalogTypeFilter) => void
  openFolder: (folderId: CatalogFolderId) => void
  beginSourceDrag: (event: DragEvent, source: ProjectInputSourceSummaryVO) => boolean
  openFileMenu: (
    event: { clientX: number; clientY: number },
    source: ProjectInputSourceSummaryVO
  ) => void
  openFolderMenu: (event: { clientX: number; clientY: number }, folderId: string) => void
  openBlankMenu: (event: { clientX: number; clientY: number }) => void
  closeMenu: () => void
  importFiles: (options?: CatalogImportOptions) => Promise<CatalogImportOutcome>
  acceptDroppedFiles: (event: DragEvent, parentFolderId?: CatalogFolderId) => void
  allowExternalDrop: (event: DragEvent) => void
  useOnCanvas: (sourceId: string) => void
  openSource: (sourceId: string) => Promise<void>
  copyFile: (sourceId: string) => void
  cutFile: (sourceId: string) => void
  copyFolder: (folderId: string) => void
  pasteHere: (targetFolderId: CatalogFolderId) => Promise<void>
  beginCreateFolder: (parentFolderId: CatalogFolderId) => void
  beginCreateMaterial: (parentFolderId: CatalogFolderId) => void
  closeCreateChooser: () => void
  emptyDocument: { parentFolderId: CatalogFolderId } | null
  closeEmptyDocument: () => void
  saveEmptyDocument: (draft: {
    fileName: string
    content: { textKind: 'document'; format: 'markdown' | 'plainText'; body: string }
  }) => Promise<void>
  chooseCreateDocument: () => void
  chooseCreateMedia: () => void
  beginRenameFile: (sourceId: string) => void
  beginRenameFolder: (folderId: string) => void
  setNameDraft: (name: string) => void
  submitName: () => Promise<void>
  closeNameDialog: () => void
  beginDeleteFile: (sourceId: string) => void
  confirmDeleteFile: () => Promise<void>
  closeDeleteFile: () => void
  beginDeleteFolder: (folderId: string) => void
  confirmDeleteFolder: () => Promise<void>
  closeDeleteFolder: () => void
}
