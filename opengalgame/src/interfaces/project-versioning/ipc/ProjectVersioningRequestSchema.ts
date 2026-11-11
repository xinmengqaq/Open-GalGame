import { z } from 'zod'

const targetSchema = z.strictObject({
  kind: z.string(),
  id: z.string()
})

const saveModeSchema = z.enum(['manual', 'system'])
const contentSourceSchema = z.enum(['operation', 'ai'])

export const listVersionHistorySchema = z.strictObject({
  projectId: z.string(),
  sourceModule: z.string().optional(),
  target: targetSchema.optional(),
  saveMode: saveModeSchema.optional(),
  contentSource: contentSourceSchema.optional(),
  cursor: z.string().optional(),
  pageSize: z.number().finite().int().positive()
})

export const undoVersionHistorySchema = z.strictObject({
  projectId: z.string(),
  historyId: z.string()
})

const entrySelectionSchema = z.strictObject({
  kind: z.literal('entry'),
  historyId: z.string()
})

const categorySelectionSchema = z.strictObject({
  kind: z.literal('category'),
  saveMode: saveModeSchema,
  throughHistoryId: z.string(),
  sourceModule: z.string().optional(),
  target: targetSchema.optional(),
  contentSource: contentSourceSchema.optional()
})

export const clearVersionHistorySchema = z.strictObject({
  projectId: z.string(),
  selection: z.discriminatedUnion('kind', [entrySelectionSchema, categorySelectionSchema])
})
