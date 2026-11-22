import { z } from 'zod'
import type { Response } from '@common/contracts/Response'

const responseSchema = z.object({
  code: z.number(),
  msg: z.string()
})

export function isResponse(value: unknown): value is Response {
  return responseSchema.safeParse(value).success
}
