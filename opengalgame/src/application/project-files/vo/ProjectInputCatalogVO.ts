import type { ProjectInputSourceSummaryVO } from './ProjectInputSourceVO'

export type ProjectFolderVO = {
  folderId: string
  parentFolderId: string | null
  name: string
}

/** 同一次读取窗口内的目录和来源摘要。 */
export type ProjectInputCatalogVO = {
  projectId: string
  catalogVersion: string
  folders: readonly ProjectFolderVO[]
  sources: readonly ProjectInputSourceSummaryVO[]
}

/** 文件夹删除前的只读计划。确认请求必须绑定这两个版本。 */
export type ProjectFolderDeletionPlanVO = {
  folderId: string
  name: string
  catalogVersion: string
  folderCount: number
  fileCount: number
  deletionVersion: string
}
