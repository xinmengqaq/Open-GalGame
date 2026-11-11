import { z } from 'zod'

import { MAX_IDENTITY_BYTES } from '@infrastructure/project-files/projectFilePaths'

/** 场景画布编排格式。旧格式不静默转换。 */
export const SCENE_CANVAS_ARRANGEMENT_FORMAT_VERSION = 4

const identity = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => Buffer.byteLength(value) <= MAX_IDENTITY_BYTES && !value.includes('\0'))

const layout = z.strictObject({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number()
})

const promptReference = z.strictObject({
  cardId: identity
})

const webgalPreset = z.union([
  z.null(),
  z.strictObject({
    command: z.string(),
    name: z.string()
  })
])

export const sceneCanvasArrangementFormatProbeSchema = z.object({
  formatVersion: z.number()
})

export const sceneCanvasArrangementDocumentSchema = z.strictObject({
  formatVersion: z.literal(SCENE_CANVAS_ARRANGEMENT_FORMAT_VERSION),
  projectId: identity,
  sceneId: identity,
  canvasId: identity,
  viewport: z.strictObject({
    x: z.number(),
    y: z.number(),
    zoom: z.number()
  }),
  cards: z.array(
    z.discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('document'),
        cardId: identity,
        sourceId: identity,
        title: z.string(),
        summary: z.string(),
        layout
      }),
      z.strictObject({
        kind: z.literal('image'),
        cardId: identity,
        sourceId: identity,
        role: z.enum(['background', 'cg', 'characterImage', 'avatar']),
        title: z.string(),
        summary: z.string().default(''),
        layout
      }),
      z.strictObject({
        kind: z.literal('audio'),
        cardId: identity,
        sourceId: identity,
        role: z.enum(['music', 'soundEffect', 'voice']),
        title: z.string(),
        summary: z.string().default(''),
        layout
      }),
      z.strictObject({
        kind: z.literal('video'),
        cardId: identity,
        sourceId: identity,
        title: z.string(),
        summary: z.string().default(''),
        layout
      }),
      z.strictObject({
        kind: z.literal('prompt'),
        cardId: identity,
        body: z.string(),
        references: z.array(promptReference).optional(),
        layout
      }),
      z.strictObject({
        kind: z.literal('animation'),
        cardId: identity,
        webgalPreset,
        layout
      }),
      z.strictObject({
        kind: z.literal('effect'),
        cardId: identity,
        webgalPreset,
        layout
      })
    ])
  ),
  relations: z.array(
    z.strictObject({
      relationId: identity,
      fromCardId: identity,
      toCardId: identity,
      specificName: z.string(),
      recordCardId: identity.nullable()
    })
  )
})

export type SceneCanvasArrangementDocument = z.infer<typeof sceneCanvasArrangementDocumentSchema>
