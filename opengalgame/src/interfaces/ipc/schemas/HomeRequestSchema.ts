import { z } from 'zod'

import { OPERATION_ID_PATTERN } from '@common/contracts/OperationId'

export const createProjectSchema = z.strictObject({
  operationId: z.string().regex(OPERATION_ID_PATTERN),
  name: z.string(),
  synopsis: z.string().optional()
})
export const importProjectSchema = createProjectSchema.pick({ operationId: true })
export const listProjectsSchema = z.strictObject({
  offset: z.number().int().min(0),
  limit: z.number().int().min(1).max(24)
})
export const openProjectSchema = z.strictObject({
  id: z.string()
})
export const unregisterProjectSchema = openProjectSchema
export const renameProjectSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  synopsis: z.string().optional()
})
export const ensureProjectWorkspaceSchema = z.strictObject({
  projectId: z.string()
})
export const inspectProjectWorkspaceSchema = ensureProjectWorkspaceSchema
