import type { ProjectFolder } from '@domain/project-files/models/ProjectInputCatalog'
import type { ProjectInputSourceSummary } from '@domain/project-files/models/ProjectInputSource'

export type CatalogSourceFact = ProjectInputSourceSummary & {
  parentFolderId: string | null
}

export type ProjectInputCatalogReadFact = {
  projectId: string
  catalogVersion: string
  folders: readonly ProjectFolder[]
  sources: readonly CatalogSourceFact[]
}

export type ProjectFolderDeletionReadFact = {
  folderId: string
  name: string
  catalogVersion: string
  folderCount: number
  fileCount: number
  deletionVersion: string
}
