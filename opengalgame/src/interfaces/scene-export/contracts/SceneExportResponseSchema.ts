import { z } from 'zod'

import type { SavedSceneVersionVO } from '@application/scene-export/vo/SavedSceneVersionVO'
import type { SceneExportDirectoryChoiceVO } from '@application/scene-export/vo/SceneExportDestinationVO'
import type { SceneExportResultVO } from '@application/scene-export/vo/SceneExportVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { OPERATION_ID_PATTERN } from '@common/contracts/OperationId'
import { failureResultSchema } from '../../contracts/FailureResultSchema'

const identity = z.string().min(1).max(128)
const safeText = z.string().min(1).max(200)
const relativePath = z
  .string()
  .min(1)
  .max(300)
  .refine((value) => !value.includes('..') && !value.includes('\\') && !/^[A-Za-z]:/.test(value))
const absolutePath = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => !value.includes('\u0000'))
  .refine((value) => /^(?:[A-Za-z]:[\\/]|\\\\|\/)/u.test(value))
const contentBasis = z.strictObject({
  digest: identity,
  parserVersion: identity,
  engineVersion: identity
})
const versionReference = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('preview-save'),
    requestId: identity
  }),
  z.strictObject({
    kind: z.literal('generation-commit'),
    operationId: z.string().regex(OPERATION_ID_PATTERN),
    commitId: z.string().regex(/^[0-9a-f]{40}$/u)
  })
])
const artifact = z.strictObject({
  executableName: z.literal('WebGAL.exe'),
  directoryName: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/),
  directoryPath: absolutePath,
  bytes: z.number().int().positive().max(2_000_000_000),
  containsFixedEngine: z.literal(true),
  entryRelativePath: relativePath,
  contentBasis,
  versionReference
})
const exportResult = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('exporting') }),
  z.strictObject({ status: z.literal('succeeded'), artifact }),
  z.strictObject({ status: z.literal('failed'), message: safeText }),
  z.strictObject({
    status: z.literal('unavailable'),
    reason: z.literal('windowsPackagerUnavailable'),
    message: safeText
  })
])

const boundedFailureResultSchema = failureResultSchema.extend({ msg: z.string().max(200) })

export function parseSceneExportResult(value: unknown): AjaxResult<SceneExportResultVO> | null {
  const parsed = z
    .union([
      z.strictObject({
        code: z.literal(ErrorCodes.success),
        msg: z.string().max(200),
        data: exportResult
      }),
      boundedFailureResultSchema
    ])
    .safeParse(value)
  return parsed.success ? parsed.data : null
}

const savedSceneVersion = z.strictObject({
  versionReference,
  revisionDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  contentBasis
})

/**
 * @returns 最新可导出正式版本的安全结果；没有版本时为 null。
 */
export function parseLatestSavedSceneVersionResult(
  value: unknown
): AjaxResult<SavedSceneVersionVO | null> | null {
  const parsed = z
    .union([
      z.strictObject({
        code: z.literal(ErrorCodes.success),
        msg: z.string().max(200),
        data: savedSceneVersion.nullable()
      }),
      boundedFailureResultSchema
    ])
    .safeParse(value)
  return parsed.success ? parsed.data : null
}

const directoryChoice = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('selected'),
    selectionId: z.string().uuid(),
    directoryPath: absolutePath
  }),
  z.strictObject({ status: z.literal('canceled') })
])

/**
 * @returns 导出目录选择结果；取消也是成功结果，不当作失败。
 */
export function parseSceneExportDirectoryChoiceResult(
  value: unknown
): AjaxResult<SceneExportDirectoryChoiceVO> | null {
  const parsed = z
    .union([
      z.strictObject({
        code: z.literal(ErrorCodes.success),
        msg: z.string().max(200),
        data: directoryChoice
      }),
      boundedFailureResultSchema
    ])
    .safeParse(value)
  return parsed.success ? parsed.data : null
}
