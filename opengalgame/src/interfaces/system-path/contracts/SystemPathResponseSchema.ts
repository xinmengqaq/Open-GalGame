import { z } from 'zod'

import type { AjaxResult } from '@common/contracts/AjaxResult'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { failureResultSchema } from '../../contracts/FailureResultSchema'

/** 本域旧失败信封一直限制 msg≤200；共享失败模式其余不变。 */
const boundedFailureResultSchema = failureResultSchema.extend({ msg: z.string().max(200) })

/**
 * @returns 打开目录的安全结果；成功时只返回 null，不返回路径。
 */
export function parseOpenDirectoryResult(value: unknown): AjaxResult<null> | null {
  const parsed = z
    .union([
      z.strictObject({
        code: z.literal(ErrorCodes.success),
        msg: z.string().max(200),
        data: z.null()
      }),
      boundedFailureResultSchema
    ])
    .safeParse(value)
  return parsed.success ? parsed.data : null
}
