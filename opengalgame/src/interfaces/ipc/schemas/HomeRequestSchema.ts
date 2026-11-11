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
const connectionApiKeySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('keep') }),
  z.strictObject({ kind: z.literal('replace'), value: z.string() })
])
/** 扩展原文上限与领域 8 KiB 一致，协议层先挡住超长字符串。 */
const connectionExtensionMaxChars = 8 * 1024
const connectionExtensionSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('keep') }),
    z.strictObject({
      kind: z.literal('set'),
      value: z.string().max(connectionExtensionMaxChars)
    }),
    z.strictObject({ kind: z.literal('clear') })
  ])
  .default({ kind: 'keep' })
export const connectionSettingsSchema = z.strictObject({
  providerId: z.enum(['openai-compatible', 'anthropic']),
  baseUrl: z.string(),
  model: z.string(),
  contextWindow: z.number(),
  maxOutputTokens: z.number(),
  temperature: z.number().optional(),
  topP: z.number().optional(),
  apiKey: connectionApiKeySchema,
  extension: connectionExtensionSchema
})
export const listModelsSchema = z.strictObject({
  providerId: z.enum(['openai-compatible', 'anthropic']),
  baseUrl: z.string(),
  apiKey: connectionApiKeySchema,
  extension: connectionExtensionSchema
})
