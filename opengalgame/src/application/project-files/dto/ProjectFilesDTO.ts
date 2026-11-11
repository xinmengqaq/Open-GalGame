export type InspectProjectFilesDTO = {
  projectId: string
}

export type ListProjectInputSourcesDTO = {
  projectId: string
}

export type ReadProjectInputSourcesDTO = {
  projectId: string
  sourceIds: readonly string[]
}

export type ProjectCatalogWriteScopeDTO = {
  projectId: string
  expectedCatalogVersion: string
}

export type ImportProjectFilesDTO = ProjectCatalogWriteScopeDTO & {
  parentFolderId: string | null
  localFilePaths: readonly string[]
}

export type ProjectFileScopeDTO = {
  projectId: string
  sourceId: string
}

/** 按已登记工程和来源身份读取媒体。不接受路径。 */
export type ReadProjectMediaDTO = {
  projectId: string
  sourceId: string
}

export type RenameProjectFileDTO = ProjectCatalogWriteScopeDTO & {
  sourceId: string
  newFileName: string
}

export type DeleteProjectFileDTO = ProjectCatalogWriteScopeDTO & {
  sourceId: string
}

export type CreateProjectTextFileDTO = ProjectCatalogWriteScopeDTO & {
  parentFolderId: string | null
  fileName: string
  content: { textKind: 'document'; format: 'markdown' | 'plainText'; body: string }
}

/** 只更新已导入文档的正文。文件名、格式和目录不变。 */
export type UpdateProjectTextFileBodyDTO = {
  projectId: string
  sourceId: string
  expectedSourceVersion: string
  content: { textKind: 'document'; body: string }
}

export type CreateProjectFolderDTO = ProjectCatalogWriteScopeDTO & {
  parentFolderId: string | null
  name: string
}

export type CopyProjectFileDTO = ProjectCatalogWriteScopeDTO & {
  operationId: string
  sourceId: string
  targetFolderId: string | null
}

export type MoveProjectFileDTO = ProjectCatalogWriteScopeDTO & {
  operationId: string
  sourceId: string
  expectedParentFolderId: string | null
  targetFolderId: string | null
}

export type CopyProjectFolderDTO = ProjectCatalogWriteScopeDTO & {
  operationId: string
  folderId: string
  targetFolderId: string | null
}

export type RenameProjectFolderDTO = ProjectCatalogWriteScopeDTO & {
  folderId: string
  newName: string
}

export type ProjectFolderScopeDTO = {
  projectId: string
  folderId: string
}

export type ReadProjectFileOperationDTO = {
  projectId: string
  operationId: string
}

export type DeleteProjectFolderDTO = ProjectCatalogWriteScopeDTO & {
  folderId: string
  expectedDeletionVersion: string
}
