import { z } from 'zod'

import type { AjaxResult } from '@common/contracts/AjaxResult'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { SceneCanvasArrangementVO } from '@application/scene-canvas/vo/SceneCanvasArrangementVO'
import { sceneCanvasArrangementSchema } from './SceneCanvasProtocolSchema'

const failedResultSchema = z.strictObject({
  code: z.number().refine((code) => code !== ErrorCodes.success),
  msg: z.string()
})

const arrangementResultSchema = z.union([
  z.strictObject({
    code: z.literal(ErrorCodes.success),
    msg: z.string(),
    data: sceneCanvasArrangementSchema
  }),
  failedResultSchema
])

const nullableArrangementResultSchema = z.union([
  z.strictObject({
    code: z.literal(ErrorCodes.success),
    msg: z.string(),
    data: sceneCanvasArrangementSchema.nullable()
  }),
  failedResultSchema
])

const nullResultSchema = z.union([
  z.strictObject({
    code: z.literal(ErrorCodes.success),
    msg: z.string(),
    data: z.null()
  }),
  failedResultSchema
])

function parseResult<T>(schema: z.ZodType<T>, value: unknown): T | null {
  const parsed = schema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/**
 * 校验编辑后的整份编排。缺字段或旧用途字段都不接受。
 * @returns 校验后的响应；结构不符时为 null。
 */
export function parseSceneCanvasArrangementResult(
  value: unknown
): AjaxResult<SceneCanvasArrangementVO> | null {
  return parseResult(arrangementResultSchema, value)
}

/**
 * 校验读取结果。没有保存文件时 data 为 null，损坏不是成功空编排。
 * @returns 校验后的响应；结构不符时为 null。
 */
export function parseSceneCanvasReadResult(
  value: unknown
): AjaxResult<SceneCanvasArrangementVO | null> | null {
  return parseResult(nullableArrangementResultSchema, value)
}

/**
 * 校验保存响应。成功 data 必须是 null。
 * @returns 校验后的响应；结构不符时为 null。
 */
export function parseSceneCanvasSaveResult(value: unknown): AjaxResult<null> | null {
  return parseResult(nullResultSchema, value)
}
