import { z } from 'zod'

import { WEBGAL_AUDITED_VERSION } from '@common/config/WebgalVersion'
import { OPERATION_ID_PATTERN } from '@common/contracts/OperationId'

const identity = z.string().trim().min(1).max(128)
const operationId = z.string().regex(OPERATION_ID_PATTERN)

const contentBasis = z.strictObject({
  digest: identity,
  parserVersion: z.literal(WEBGAL_AUDITED_VERSION),
  engineVersion: z.literal(WEBGAL_AUDITED_VERSION)
})

const versionReference = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('preview-save'),
    requestId: identity
  }),
  z.strictObject({
    kind: z.literal('generation-commit'),
    operationId,
    commitId: z.string().regex(/^[0-9a-f]{40}$/u)
  })
])

/** 目的地只接受工程默认位置或主进程签发的选择；任意路径字段都会被严格对象拒绝。 */
const destination = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('workspace') }),
  z.strictObject({
    kind: z.literal('selected'),
    selectionId: z.string().uuid()
  })
])

export const exportSavedSceneSchema = z.strictObject({
  projectId: identity,
  sceneId: identity,
  contentBasis,
  versionReference,
  destination: destination.optional()
})

export const readLatestSavedSceneVersionSchema = z.strictObject({
  projectId: identity,
  sceneId: identity
})

export const chooseSceneExportDirectorySchema = z.strictObject({
  projectId: identity,
  sceneId: identity
})
