import { z } from 'zod'

import { ErrorCodes } from '@common/errors/ErrorCodes'
import { failureResultSchema } from './FailureResultSchema'

const projectSummaryShape = {
  id: z.string(),
  name: z.string(),
  synopsis: z.string()
}

const projectListEntrySchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('available'), ...projectSummaryShape }),
  z.object({ status: z.literal('unavailable'), id: z.string(), code: z.number(), msg: z.string() })
])

const projectListResultSchema = z.union([
  z.object({
    code: z.literal(ErrorCodes.success),
    msg: z.string(),
    data: z.object({
      entries: z.array(projectListEntrySchema),
      total: z.number(),
      offset: z.number(),
      limit: z.number()
    })
  }),
  failureResultSchema
])

export function isProjectListResult(value: unknown): boolean {
  return projectListResultSchema.safeParse(value).success
}
