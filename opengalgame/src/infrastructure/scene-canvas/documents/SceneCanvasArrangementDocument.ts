import { z } from 'zod'

import { MAX_IDENTITY_BYTES } from '@infrastructure/project-files/public/projectFileStorage'

/**
 * 场景画布编排当前格式。旧 v3/旧 v4 只由迁移工具读取，产品侧不静默转换；
 * 当前格式是唯一读写格式，承载生成输入使用的真实业务字段。
 */
export const SCENE_CANVAS_ARRANGEMENT_FORMAT_VERSION = 5

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

const webgalPreset = z.union([
  z.null(),
  z.strictObject({
    command: z.string(),
    name: z.string()
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
        usage,
        layout
      }),
      z.strictObject({
        kind: z.literal('image'),
        cardId: identity,
        sourceId: identity,
        role: z.enum(['background', 'cg', 'characterImage', 'avatar']),
        title: z.string(),
        summary: z.string(),
        usage,
        layout
      }),
      z.strictObject({
        kind: z.literal('audio'),
        cardId: identity,
        sourceId: identity,
        role: z.enum(['music', 'soundEffect', 'voice']),
        title: z.string(),
        summary: z.string(),
        usage,
        layout
      }),
      z.strictObject({
        kind: z.literal('video'),
        cardId: identity,
        sourceId: identity,
        title: z.string(),
        summary: z.string(),
        usage,
        layout
      }),
      z.strictObject({
        kind: z.literal('prompt'),
        cardId: identity,
        title: z.string(),
        summary: z.string(),
        body: z.string(),
        references: z.array(promptReference).optional(),
        usage,
        layout
      }),
      z.strictObject({
        kind: z.literal('animation'),
        cardId: identity,
        title: z.string(),
        summary: z.string(),
        webgalPreset,
        usage,
        layout
      }),
      z.strictObject({
        kind: z.literal('effect'),
        cardId: identity,
        title: z.string(),
        summary: z.string(),
        webgalPreset,
        usage,
        layout
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
