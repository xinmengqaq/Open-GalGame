import { z } from 'zod'

import { ErrorCodes } from '@common/errors/ErrorCodes'

/**
 * 失败结果的唯一模式：成功码不能出现，失败不携带 `data`。
 * `reason` 是失败专属的可选结构化原因，只给同码需要跨进程判别的业务使用；
 * 类型与 `AppException.reason` 一致为自由字符串，不预设长度或业务枚举：
 * 未知原因也必须能安全跨进程，不能变成通信失败。旧 payload 没有它仍然合法。
 * 所有通道的失败信封都复用本模式，不各自复制；原边界更窄的旧通道在各自
 * schema 内用 `.extend()` 收紧 `msg`，不改动共享模式。
 *
 * `msg` 默认不设上限：统一成任一通道原有的上限都会让既有的合规失败信封变成
 * 通信失败；失败文案只由主进程的 `AppException` 与固定错误字典产生。
 */
export const failureResultSchema = z.strictObject({
  code: z.number().refine((code) => code !== ErrorCodes.success),
  msg: z.string(),
  reason: z.string().optional()
})

/** 失败结果的安全投影；成功响应不携带 `reason`。 */
export type FailureResult = z.output<typeof failureResultSchema>
