import { z } from 'zod'

import {
  assertAssetMediaPath,
  MAX_IDENTITY_BYTES,
  PROJECT_INPUT_FORMAT_VERSION
} from '../projectFilePaths'

const identity = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => Buffer.byteLength(value) <= MAX_IDENTITY_BYTES && !value.includes('\0'))

const bodyFile = z.string().regex(/^[0-9a-f]+\.(md|txt)$/u)

export const projectInputSourceFormatProbeSchema = z.object({
  formatVersion: z.number(),
  projectId: z.string().optional(),
  sourceId: z.string().optional()
})

export const projectInputSourceDocumentSchema = z.strictObject({
  formatVersion: z.literal(PROJECT_INPUT_FORMAT_VERSION),
  projectId: identity,
  sourceId: identity,
  content: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('document'),
      title: z.string(),
      topics: z.array(z.string()),
      importFormat: z.enum(['markdown', 'plainText']),
      bodyFile
    }),
    z.strictObject({
      kind: z.literal('asset'),
      name: z.string(),
      fileType: z.enum(['image', 'audio', 'video']),
      description: z.string(),
      fileId: identity,
      mediaPath: z.string().refine((value) => {
        try {
          assertAssetMediaPath(value)
          return true
        } catch {
          return false
        }
      })
    })
  ])
})

export type ProjectInputSourceDocument = z.infer<typeof projectInputSourceDocumentSchema>
export type ProjectInputSourceFormatProbe = z.infer<typeof projectInputSourceFormatProbeSchema>
