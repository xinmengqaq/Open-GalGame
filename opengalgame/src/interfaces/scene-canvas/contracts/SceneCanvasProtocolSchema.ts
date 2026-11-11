import { z } from 'zod'

const layoutSchema = z.strictObject({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number()
})

const promptReferenceSchema = z.strictObject({
  cardId: z.string(),
  displayName: z.string().optional()
})

const presetSchema = z.strictObject({
  command: z.string(),
  name: z.string()
})

/** 请求和响应共用的编排结构。不引用持久化 Document。 */
export const sceneCanvasArrangementSchema = z.strictObject({
  projectId: z.string(),
  sceneId: z.string(),
  canvasId: z.string(),
  viewport: z.strictObject({
    x: z.number(),
    y: z.number(),
    zoom: z.number()
  }),
  cards: z.array(
    z.discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('document'),
        cardId: z.string(),
        sourceId: z.string(),
        title: z.string(),
        summary: z.string(),
        layout: layoutSchema
      }),
      z.strictObject({
        kind: z.literal('image'),
        cardId: z.string(),
        sourceId: z.string(),
        role: z.enum(['background', 'cg', 'characterImage', 'avatar']),
        title: z.string(),
        summary: z.string(),
        layout: layoutSchema
      }),
      z.strictObject({
        kind: z.literal('audio'),
        cardId: z.string(),
        sourceId: z.string(),
        role: z.enum(['music', 'soundEffect', 'voice']),
        title: z.string(),
        summary: z.string(),
        layout: layoutSchema
      }),
      z.strictObject({
        kind: z.literal('video'),
        cardId: z.string(),
        sourceId: z.string(),
        title: z.string(),
        summary: z.string(),
        layout: layoutSchema
      }),
      z.strictObject({
        kind: z.literal('prompt'),
        cardId: z.string(),
        body: z.string(),
        references: z.array(promptReferenceSchema),
        layout: layoutSchema
      }),
      z.strictObject({
        kind: z.literal('animation'),
        cardId: z.string(),
        webgalPreset: presetSchema.nullable(),
        layout: layoutSchema
      }),
      z.strictObject({
        kind: z.literal('effect'),
        cardId: z.string(),
        webgalPreset: presetSchema.nullable(),
        layout: layoutSchema
      })
    ])
  ),
  relations: z.array(
    z.strictObject({
      relationId: z.string(),
      fromCardId: z.string(),
      toCardId: z.string(),
      specificName: z.string(),
      recordCardId: z.string().nullable()
    })
  )
})

export const sceneCanvasLayoutSchema = layoutSchema
export const sceneCanvasPresetSchema = presetSchema
