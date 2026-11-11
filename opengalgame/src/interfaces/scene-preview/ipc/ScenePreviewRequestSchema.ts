import { z } from 'zod'

const identity = z.string().trim().min(1).max(128)
const text = z.string().max(4000)
const generation = z.number().int().positive().max(1_000_000)
const contentBasis = z.strictObject({
  digest: identity,
  parserVersion: identity,
  engineVersion: identity
})
const dialogueEdit = z.strictObject({
  dialogueId: identity,
  text
})

export const readScenePreviewAvailabilitySchema = z.strictObject({
  projectId: identity,
  sceneId: identity
})

export const openScenePreviewSchema = readScenePreviewAvailabilitySchema

export const previewSessionSchema = z.strictObject({
  previewSessionId: identity
})

export const subscribePreviewRuntimeSchema = previewSessionSchema.extend({
  projectId: identity,
  sceneId: identity
})

export const previewDialogueDraftSchema = z.strictObject({
  previewSessionId: identity,
  expectedRuntimeGeneration: generation,
  dialogueId: identity,
  editRevision: generation,
  text
})

export const saveDialogueChangesSchema = z.strictObject({
  previewSessionId: identity,
  requestId: identity,
  baseContentBasis: contentBasis,
  edits: z.array(dialogueEdit).min(1).max(1000)
})

export const readDialogueSaveSettlementSchema = z.strictObject({
  projectId: identity,
  sceneId: identity,
  requestId: identity
})

export const previewDialoguePlaybackSchema = z.strictObject({
  previewSessionId: identity,
  expectedRuntimeGeneration: generation,
  dialogueId: identity
})

export const readCandidatePreviewSchema = z.strictObject({
  projectId: identity,
  sceneId: identity,
  previewSessionId: identity
})
