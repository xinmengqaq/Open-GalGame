import { z } from 'zod'

import type { AjaxResult } from '@common/contracts/AjaxResult'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { failureResultSchema } from '../../contracts/FailureResultSchema'

const boundedFailureResultSchema = failureResultSchema.extend({ msg: z.string().max(200) })

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
