import { z } from 'zod'

import { ErrorCodes } from '@common/errors/ErrorCodes'

export const failureResultSchema = z.strictObject({
  code: z.number().refine((code) => code !== ErrorCodes.success),
  msg: z.string(),
  reason: z.string().optional()
})

export type FailureResult = z.output<typeof failureResultSchema>
