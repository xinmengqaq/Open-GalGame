import { z } from 'zod'

import type { UpdateCheckVO, UpdateStatusVO } from '@application/app-update/vo/AppUpdateVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import { ErrorCodes } from '@common/errors/ErrorCodes'

const appVersion = z.string().regex(/^\d+\.\d+\.\d+$/u)
const releaseSummary = z.strictObject({
  version: appVersion,
  releaseName: z.string().max(500).optional(),
  releaseNotes: z.string().max(1_000_000).optional(),
  releasedAt: z.string().max(100).optional()
})
const updatePhase = z.enum([
  'idle',
  'checking',
  'available',
  'downloading',
  'downloaded',
  'installing',
  'failed'
])
const updateFailure = z.strictObject({
  kind: z.enum([
    'unsupported',
    'source-unavailable',
    'download-failed',
    'install-failed',
    'invalid-state'
  ]),
  message: z.string().min(1).max(200)
})
const updateProgress = z.strictObject({
  percent: z.number().int().min(0).max(100),
  transferred: z.number().finite().nonnegative().max(2_000_000_000_000),
  total: z.number().finite().nonnegative().max(2_000_000_000_000),
  bytesPerSecond: z.number().finite().nonnegative().max(2_000_000_000_000)
})

const updateStatus = z
  .strictObject({
    phase: updatePhase,
    currentVersion: appVersion,
    supported: z.boolean(),
    release: releaseSummary.optional(),
    progress: updateProgress.optional(),
    failure: updateFailure.optional()
  })
  .superRefine((status, context) => {
    if (status.phase === 'available' && status.release === undefined) {
      context.addIssue({ code: 'custom', message: '可更新状态缺少版本信息', path: ['release'] })
    }
    if (
      (status.phase === 'downloading' || status.phase === 'downloaded') &&
      (status.release === undefined || status.progress === undefined)
    ) {
      context.addIssue({ code: 'custom', message: '下载状态缺少版本或进度', path: ['progress'] })
    }
    if (status.phase === 'installing' && status.release === undefined) {
      context.addIssue({ code: 'custom', message: '安装状态缺少版本信息', path: ['release'] })
    }
    if (status.phase === 'failed' && status.failure === undefined) {
      context.addIssue({ code: 'custom', message: '失败状态缺少失败信息', path: ['failure'] })
    }
  })

const updateCheck = z.discriminatedUnion('phase', [
  z.strictObject({
    phase: z.literal('available'),
    currentVersion: appVersion,
    release: releaseSummary
  }),
  z.strictObject({
    phase: z.literal('idle'),
    currentVersion: appVersion
  })
])

const failedResult = z.strictObject({
  code: z.number().refine((code) => code !== ErrorCodes.success),
  msg: z.string().max(200)
})

/**
 * @returns 合法的更新状态；阶段与附带事实不一致时为 null。
 */
export function parseUpdateStatusEvent(value: unknown): UpdateStatusVO | null {
  const parsed = updateStatus.safeParse(value)
  return parsed.success ? parsed.data : null
}

/**
 * @returns 读取状态的安全结果。
 */
export function parseUpdateStatusResult(value: unknown): AjaxResult<UpdateStatusVO> | null {
  const parsed = z
    .union([
      z.strictObject({
        code: z.literal(ErrorCodes.success),
        msg: z.string().max(200),
        data: updateStatus
      }),
      failedResult
    ])
    .safeParse(value)
  return parsed.success ? parsed.data : null
}

/**
 * @returns 检查更新的安全结果。
 */
export function parseUpdateCheckResult(value: unknown): AjaxResult<UpdateCheckVO> | null {
  const parsed = z
    .union([
      z.strictObject({
        code: z.literal(ErrorCodes.success),
        msg: z.string().max(200),
        data: updateCheck
      }),
      failedResult
    ])
    .safeParse(value)
  return parsed.success ? parsed.data : null
}

/**
 * @returns 安装请求的安全结果；成功时只有 null。
 */
export function parseInstallUpdateResult(value: unknown): AjaxResult<null> | null {
  const parsed = z
    .union([
      z.strictObject({
        code: z.literal(ErrorCodes.success),
        msg: z.string().max(200),
        data: z.null()
      }),
      failedResult
    ])
    .safeParse(value)
  return parsed.success ? parsed.data : null
}
