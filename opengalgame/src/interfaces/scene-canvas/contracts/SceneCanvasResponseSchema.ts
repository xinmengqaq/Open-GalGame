import { z } from 'zod'

import type { AjaxResult } from '@common/contracts/AjaxResult'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { SceneCanvasArrangementVO } from '@application/scene-canvas/vo/SceneCanvasArrangementVO'
import { sceneCanvasArrangementSchema } from './SceneCanvasProtocolSchema'
import { failureResultSchema } from '../../contracts/FailureResultSchema'

const arrangementResultSchema = z.union([
  z.strictObject({
    code: z.literal(ErrorCodes.success),
    msg: z.string(),
    data: sceneCanvasArrangementSchema
  }),
  failureResultSchema
])

const nullableArrangementResultSchema = z.union([
  z.strictObject({
    code: z.literal(ErrorCodes.success),
    msg: z.string(),
    data: sceneCanvasArrangementSchema.nullable()
  }),
  failureResultSchema
])

const nullResultSchema = z.union([
  z.strictObject({
    code: z.literal(ErrorCodes.success),
    msg: z.string(),
    data: z.null()
  }),
  failureResultSchema
])

function parseResult<T>(schema: z.ZodType<T>, value: unknown): T | null {
  const parsed = schema.safeParse(value)
  return parsed.success ? parsed.data : null
}

export function parseSceneCanvasArrangementResult(
  value: unknown
): AjaxResult<SceneCanvasArrangementVO> | null {
  return parseResult(arrangementResultSchema, value)
}

export function parseSceneCanvasReadResult(
  value: unknown
): AjaxResult<SceneCanvasArrangementVO | null> | null {
  return parseResult(nullableArrangementResultSchema, value)
}

export function parseSceneCanvasSaveResult(value: unknown): AjaxResult<null> | null {
  return parseResult(nullResultSchema, value)
}
