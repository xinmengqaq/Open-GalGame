import { z } from 'zod'

export const inspectProjectFilesSchema = z.strictObject({
  projectId: z.string()
})

export const listProjectInputSourcesSchema = z.strictObject({
  projectId: z.string()
})

export const readProjectInputSourcesSchema = z.strictObject({
  projectId: z.string(),
  sourceIds: z.array(z.string())
})

export const readProjectMediaSchema = z.strictObject({
  projectId: z.string(),
  sourceId: z.string()
})

export const chooseProjectFilesSchema = z.strictObject({})

const catalogWriteScope = {
  projectId: z.string(),
  expectedCatalogVersion: z.string()
}

export const importProjectFilesSchema = z.strictObject({
  ...catalogWriteScope,
  parentFolderId: z.string().nullable(),
  localFilePaths: z.array(z.string()).min(1)
})

export const projectFileScopeSchema = z.strictObject({
  projectId: z.string(),
  sourceId: z.string()
})

export const renameProjectFileSchema = z.strictObject({
  ...catalogWriteScope,
  sourceId: z.string(),
  newFileName: z.string()
})

export const deleteProjectFileSchema = z.strictObject({
  ...catalogWriteScope,
  sourceId: z.string()
})

const textContentSchema = z.strictObject({
  textKind: z.literal('document'),
  format: z.enum(['markdown', 'plainText']),
  body: z.string()
})

export const createProjectTextFileSchema = z.strictObject({
  ...catalogWriteScope,
  parentFolderId: z.string().nullable(),
  fileName: z.string(),
  content: textContentSchema
})

export const updateProjectTextFileBodySchema = z.strictObject({
  projectId: z.string(),
  sourceId: z.string(),
  expectedSourceVersion: z.string(),
  content: z.strictObject({
    textKind: z.literal('document'),
    body: z.string()
  })
})

export const createProjectFolderSchema = z.strictObject({
  ...catalogWriteScope,
  parentFolderId: z.string().nullable(),
  name: z.string()
})

export const copyProjectFileSchema = z.strictObject({
  ...catalogWriteScope,
  operationId: z.string().min(1),
  sourceId: z.string(),
  targetFolderId: z.string().nullable()
})

export const moveProjectFileSchema = z.strictObject({
  ...catalogWriteScope,
  operationId: z.string().min(1),
  sourceId: z.string(),
  expectedParentFolderId: z.string().nullable(),
  targetFolderId: z.string().nullable()
})

export const copyProjectFolderSchema = z.strictObject({
  ...catalogWriteScope,
  operationId: z.string().min(1),
  folderId: z.string(),
  targetFolderId: z.string().nullable()
})

export const renameProjectFolderSchema = z.strictObject({
  ...catalogWriteScope,
  folderId: z.string(),
  newName: z.string()
})

export const projectFolderScopeSchema = z.strictObject({
  projectId: z.string(),
  folderId: z.string()
})

export const readProjectFileOperationSchema = z.strictObject({
  projectId: z.string(),
  operationId: z.string().min(1)
})

export const deleteProjectFolderSchema = z.strictObject({
  ...catalogWriteScope,
  folderId: z.string(),
  expectedDeletionVersion: z.string()
})
