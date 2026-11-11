import type { z } from 'zod'

import { AppException } from '@common/errors/AppException'

/**
 * 解析技术边界读入的未知值，形状不符时抛出带码异常。
 * @param code - 校验失败使用的错误码。
 * @param msg - 校验失败时可安全展示的中文说明。
 * @throws {AppException} 值不符合模式。
 */
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
