import { z } from 'zod'

import {
  sceneCanvasArrangementSchema,
  sceneCanvasLayoutSchema as layoutSchema,
  sceneCanvasPresetSchema as presetSchema
} from '../contracts/SceneCanvasProtocolSchema'

const identity = {
  projectId: z.string(),
  sceneId: z.string(),
  canvasId: z.string()
}

const editBase = {
  ...identity,
  arrangement: sceneCanvasArrangementSchema
}

export const readSceneCanvasArrangementSchema = z.strictObject(identity)

export const createSceneCanvasSourceCardSchema = z.strictObject({
  ...editBase,
  sourceId: z.string(),
  layout: layoutSchema
})

export const createSceneCanvasPromptCardSchema = z.strictObject({
  ...editBase,
  layout: layoutSchema
})

export const createSceneCanvasFieldCardSchema = z.strictObject({
  ...editBase,
  kind: z.enum(['animation', 'effect']),
  layout: layoutSchema
})

export const editSceneCanvasCardSchema = z.strictObject({
  ...editBase,
  cardId: z.string(),
  title: z.string().optional(),
  summary: z.string().optional()
})

export const editSceneCanvasPromptBodySchema = z.strictObject({
  ...editBase,
  cardId: z.string(),
  body: z.string()
})

export const bindSceneCanvasFieldCardPresetSchema = z.strictObject({
  ...editBase,
  cardId: z.string(),
  preset: presetSchema.nullable()
})

export const editSceneCanvasMediaRoleSchema = z.strictObject({
  ...editBase,
  cardId: z.string(),
  role: z.enum(['background', 'cg', 'characterImage', 'avatar', 'music', 'soundEffect', 'voice'])
})

export const copySceneCanvasCardSchema = z.strictObject({
  ...editBase,
  cardId: z.string(),
  layout: layoutSchema
})

export const deleteSceneCanvasCardSchema = z.strictObject({
  ...editBase,
  cardId: z.string()
})

export const connectSceneCanvasCardsSchema = z.strictObject({
  ...editBase,
  fromCardId: z.string(),
  toCardId: z.string()
})

export const disconnectSceneCanvasCardsSchema = z.strictObject({
  ...editBase,
  relationId: z.string()
})

export const editSceneCanvasRelationNameSchema = z.strictObject({
  ...editBase,
  relationId: z.string(),
  specificName: z.string()
})

export const attachSceneCanvasRelationRecordSchema = z.strictObject({
  ...editBase,
  relationId: z.string(),
  recordCardId: z.string()
})

export const detachSceneCanvasRelationRecordSchema = z.strictObject({
  ...editBase,
  relationId: z.string()
})

export const saveSceneCanvasArrangementSchema = z.strictObject({
  ...identity,
  reason: z.enum(['periodic', 'manual', 'beforeGeneration']),
  arrangement: sceneCanvasArrangementSchema
})
