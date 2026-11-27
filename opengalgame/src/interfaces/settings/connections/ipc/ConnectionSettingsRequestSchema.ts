import { z } from 'zod'

const connectionApiKeySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('keep') }),
  z.strictObject({ kind: z.literal('replace'), value: z.string() })
])
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
