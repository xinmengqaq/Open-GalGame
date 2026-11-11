import { z } from 'zod'

const identity = z.string().trim().min(1).max(128)

const contentBasis = z.strictObject({
  digest: identity,
  parserVersion: z.literal('4.6.5'),
  engineVersion: z.literal('4.6.5')
})

export const exportSavedSceneSchema = z.strictObject({
  projectId: identity,
  sceneId: identity,
  contentBasis,
  versionReference: z.strictObject({
    kind: z.literal('preview-save'),
    requestId: identity
  })
})

export const readLatestPreviewSaveSchema = z.strictObject({
  projectId: identity,
  sceneId: identity
})
