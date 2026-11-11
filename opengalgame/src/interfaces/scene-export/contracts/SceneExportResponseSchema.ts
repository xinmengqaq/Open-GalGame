import { z } from 'zod'

import type { PreviewSaveVersionVO } from '@application/scene-export/vo/PreviewSaveVersionVO'
import type { SceneExportResultVO } from '@application/scene-export/vo/SceneExportVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import { ErrorCodes } from '@common/errors/ErrorCodes'

const identity = z.string().min(1).max(128)
const safeText = z.string().min(1).max(200)
const relativePath = z
  .string()
  .min(1)
  .max(300)
  .refine((value) => !value.includes('..') && !value.includes('\\') && !/^[A-Za-z]:/.test(value))
/** 产物绝对目录路径：盘符、UNC 或 POSIX 根路径；只用于展示与本机目录打开。 */
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
const versionReference = z.strictObject({
  kind: z.literal('preview-save'),
  requestId: identity
})
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
const failedResult = z.strictObject({
  code: z.number().refine((code) => code !== ErrorCodes.success),
  msg: z.string().max(200)
})

export function parseSceneExportResult(value: unknown): AjaxResult<SceneExportResultVO> | null {
  const parsed = z
    .union([
      z.strictObject({
        code: z.literal(ErrorCodes.success),
        msg: z.string().max(200),
        data: exportResult
      }),
      failedResult
    ])
    .safeParse(value)
  return parsed.success ? parsed.data : null
}

const previewSaveVersion = z.strictObject({
  requestId: identity,
  revisionDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  contentBasis
})

/**
 * @returns 最近预览保存版本的安全结果；没有版本时为 null。
 */
export function parseLatestPreviewSaveResult(
  value: unknown
): AjaxResult<PreviewSaveVersionVO | null> | null {
  const parsed = z
    .union([
      z.strictObject({
        code: z.literal(ErrorCodes.success),
        msg: z.string().max(200),
        data: previewSaveVersion.nullable()
      }),
      failedResult
    ])
    .safeParse(value)
  return parsed.success ? parsed.data : null
}
