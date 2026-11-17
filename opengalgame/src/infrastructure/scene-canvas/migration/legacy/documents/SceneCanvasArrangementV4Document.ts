import { z } from 'zod'

import { MAX_IDENTITY_BYTES } from '@infrastructure/project-files/public/projectFileStorage'

/**
 * R11 之前的场景画布当前格式，现仅由迁移工具读取。
 * 字段集冻结，不允许承载 title/summary/usage/defaultRelation 等后续业务字段；
 * 旧 v4 转当前格式必须经迁移映射显式补齐默认值，产品读取不再使用该版本。
 */
export const SCENE_CANVAS_ARRANGEMENT_V4_FORMAT_VERSION = 4

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

export const sceneCanvasArrangementV4DocumentSchema = z.strictObject({
  formatVersion: z.literal(SCENE_CANVAS_ARRANGEMENT_V4_FORMAT_VERSION),
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

export type SceneCanvasArrangementV4Document = z.infer<
  typeof sceneCanvasArrangementV4DocumentSchema
>
