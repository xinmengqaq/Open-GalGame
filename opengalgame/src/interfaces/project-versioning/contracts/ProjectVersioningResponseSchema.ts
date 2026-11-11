import { z } from 'zod'

import type {
  VersionHistoryClearVO,
  VersionHistoryPageVO,
  VersionHistoryUndoVO
} from '@application/project-versioning/vo/VersionHistoryVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import { ErrorCodes } from '@common/errors/ErrorCodes'

const failedResultSchema = z.strictObject({
  code: z.number().refine((code) => code !== ErrorCodes.success),
  msg: z.string()
})

const targetSchema = z.strictObject({
  kind: z.string(),
  id: z.string()
})

const entrySchema = z.strictObject({
  historyId: z.string(),
  sourceModule: z.string(),
  targets: z.array(targetSchema),
  saveMode: z.enum(['manual', 'system']),
  contentSource: z.enum(['operation', 'ai']),
  title: z.string(),
  summary: z.string(),
  createdAt: z.string(),
  state: z.enum(['已提交', '已回退']),
  canUndo: z.boolean(),
  canClear: z.boolean()
})

const historyPageSchema = z.strictObject({
  entries: z.array(entrySchema),
  nextCursor: z.string().nullable()
})

const undoResultSchema = z.strictObject({
  historyId: z.string(),
  state: z.literal('已回退')
})

const clearResultSchema = z.strictObject({
  clearedCount: z.number().int().min(0)
})

const historyPageResultSchema = z.union([
  z.strictObject({
    code: z.literal(ErrorCodes.success),
    msg: z.string(),
    data: historyPageSchema
  }),
  failedResultSchema
])

const undoResultAjaxSchema = z.union([
  z.strictObject({
    code: z.literal(ErrorCodes.success),
    msg: z.string(),
    data: undoResultSchema
  }),
  failedResultSchema
])

const clearResultAjaxSchema = z.union([
  z.strictObject({
    code: z.literal(ErrorCodes.success),
    msg: z.string(),
    data: clearResultSchema
  }),
  failedResultSchema
])

function parseResult<T>(schema: z.ZodType<T>, value: unknown): T | null {
  const parsed = schema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/**
 * 校验历史列表响应。成功响应必须带页面数据，失败响应不携带 data。
 * @returns 校验后的响应；结构不符时为 null。
 */
export function parseVersionHistoryPageResult(
  value: unknown
): AjaxResult<VersionHistoryPageVO> | null {
  return parseResult(historyPageResultSchema, value)
}

/**
 * @returns 校验后的撤销响应；结构不符时为 null。
 */
export function parseVersionHistoryUndoResult(
  value: unknown
): AjaxResult<VersionHistoryUndoVO> | null {
  return parseResult(undoResultAjaxSchema, value)
}

/**
 * @returns 校验后的清理响应；结构不符时为 null。
 */
export function parseVersionHistoryClearResult(
  value: unknown
): AjaxResult<VersionHistoryClearVO> | null {
  return parseResult(clearResultAjaxSchema, value)
}
