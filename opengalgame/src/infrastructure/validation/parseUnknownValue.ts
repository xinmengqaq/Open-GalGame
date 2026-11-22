import type { z } from 'zod'

import { AppException } from '@common/errors/AppException'

export function parseUnknownValue<T>(
  schema: z.ZodType<T>,
  value: unknown,
  code: number,
  msg: string
): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new AppException({ code, msg })
  return result.data
}
