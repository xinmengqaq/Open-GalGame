import { z } from 'zod'

import { WEBGAL_AUDITED_VERSION } from '@common/config/WebgalVersion'

const identity = z.string().trim().min(1).max(128)

const contentBasis = z.strictObject({
  digest: identity,
  parserVersion: z.literal(WEBGAL_AUDITED_VERSION),
  engineVersion: z.literal(WEBGAL_AUDITED_VERSION)
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
