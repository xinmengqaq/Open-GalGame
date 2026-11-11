import { z } from 'zod'
import type { AjaxResult } from '@common/contracts/AjaxResult'

/** 失败响应不携带 data；成功响应的 data 由各通道自己的模式判定。 */
const ajaxResultSchema = z.object({
  code: z.number(),
  msg: z.string()
})

/**
 * @returns 同时有数字 `code` 和字符串 `msg` 时为 true；缺 `code` 不是成功。
 */
export function isAjaxResult(value: unknown): value is AjaxResult {
  return ajaxResultSchema.safeParse(value).success
}
