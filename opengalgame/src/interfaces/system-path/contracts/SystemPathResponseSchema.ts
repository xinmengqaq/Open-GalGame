import { z } from 'zod'

import type { AjaxResult } from '@common/contracts/AjaxResult'
import { ErrorCodes } from '@common/errors/ErrorCodes'

const failedResult = z.strictObject({
  code: z.number().refine((code) => code !== ErrorCodes.success),
  msg: z.string().max(200)
})

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
      failedResult
    ])
    .safeParse(value)
  return parsed.success ? parsed.data : null
}
