import { z } from 'zod'

import { MAX_IDENTITY_BYTES, PROJECT_ARRANGEMENT_FORMAT_VERSION } from '../projectFilePaths'

const identity = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => Buffer.byteLength(value) <= MAX_IDENTITY_BYTES && !value.includes('\0'))

const usage = z.strictObject({
  characterId: z.string().optional(),
  locationId: z.string().optional(),
  spokenLine: z.string().optional(),
  targetIds: z.array(z.string())
})

const layout = z.strictObject({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number()
})

const promptReference = z.strictObject({
  cardId: identity
})

const cardBase = {
  cardId: identity,
  title: z.string().min(1),
  summary: z.string().default(''),
  usage,
  layout
}

const webgalPreset = z.union([
  z.null(),
  z.strictObject({
    command: z.string().min(1),
    name: z.string().min(1)
  })
])

const defaultRelation = z.enum([
  'actsOn',
  'accompanies',
  'voices',
  'depicts',
  'constrains',
  'sameSubject',
  'associated'
])

export const sceneCanvasArrangementFormatProbeSchema = z.object({
  formatVersion: z.number(),
  projectId: z.string().optional(),
  sceneId: z.string().optional(),
  canvasId: z.string().optional()
})

export const sceneCanvasArrangementDocumentSchema = z.strictObject({
  formatVersion: z.literal(PROJECT_ARRANGEMENT_FORMAT_VERSION),
  projectId: identity,
  sceneId: identity,
  canvasId: identity,
  viewport: z.strictObject({
    x: z.number(),
    y: z.number(),
    zoom: z.number().positive()
  }),
  cards: z.array(
    z.discriminatedUnion('kind', [
      z.strictObject({
        ...cardBase,
        kind: z.literal('document'),
        sourceId: identity
      }),
      z.strictObject({
        ...cardBase,
        kind: z.literal('prompt'),
        body: z.string(),
        references: z.array(promptReference).optional()
      }),
      z.strictObject({
        ...cardBase,
        kind: z.literal('image'),
        sourceId: identity,
        role: z.enum(['background', 'cg', 'characterImage', 'avatar'])
      }),
      z.strictObject({
        ...cardBase,
        kind: z.literal('audio'),
        sourceId: identity,
        role: z.enum(['music', 'soundEffect', 'voice'])
      }),
      z.strictObject({
        ...cardBase,
        kind: z.literal('video'),
        sourceId: identity
      }),
      z.strictObject({
        ...cardBase,
        kind: z.literal('animation'),
        webgalPreset
      }),
      z.strictObject({
        ...cardBase,
        kind: z.literal('effect'),
        webgalPreset
      })
    ])
  ),
  relations: z.array(
    z.strictObject({
      relationId: identity,
      fromCardId: identity,
      toCardId: identity,
      defaultRelation,
      specificName: z.string(),
      recordCardId: identity.nullable()
    })
  )
})

export type SceneCanvasArrangementDocument = z.infer<typeof sceneCanvasArrangementDocumentSchema>
export type SceneCanvasArrangementFormatProbe = z.infer<
  typeof sceneCanvasArrangementFormatProbeSchema
>
