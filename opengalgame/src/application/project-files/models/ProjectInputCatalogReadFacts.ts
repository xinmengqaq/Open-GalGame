import type { ProjectFolder } from '@domain/project-files/models/ProjectInputCatalog'
import type { ProjectInputSourceSummary } from '@domain/project-files/models/ProjectInputSource'

export type CatalogSourceFact = ProjectInputSourceSummary & {
  parentFolderId: string | null
}

/** 同一次读取窗口内的目录、归属和来源摘要。 */
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
