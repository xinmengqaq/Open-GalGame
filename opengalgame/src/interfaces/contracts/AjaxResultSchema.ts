import { z } from 'zod'
import type { AjaxResult } from '@common/contracts/AjaxResult'

const ajaxResultSchema = z.object({
  code: z.number(),
  msg: z.string()
})

export function isAjaxResult(value: unknown): value is AjaxResult {
  return ajaxResultSchema.safeParse(value).success
}
