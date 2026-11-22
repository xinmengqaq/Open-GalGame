import type { ProjectInputSourceSummaryVO } from './ProjectInputSourceVO'

export type ProjectFolderVO = {
  folderId: string
  parentFolderId: string | null
  name: string
}

export type ProjectInputCatalogVO = {
  projectId: string
  catalogVersion: string
  folders: readonly ProjectFolderVO[]
  sources: readonly ProjectInputSourceSummaryVO[]
}

export type ProjectFolderDeletionPlanVO = {
  folderId: string
  name: string
  catalogVersion: string
  folderCount: number
  fileCount: number
  deletionVersion: string
}
