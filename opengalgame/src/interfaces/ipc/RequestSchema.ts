import { z } from 'zod'

import { AppException } from '@common/errors/AppException'

export interface IpcRequestAccess {
  trusted: boolean
  requestId: string
}

/**
 * 校验来源和协议结构，不判断业务内容。
 * @throws {AppException} 来源或协议非法。
 */
export function parseRequest<T>(schema: z.ZodType<T>, input: unknown, access: IpcRequestAccess): T {
  if (!access.trusted) throw new AppException({ code: 4102, msg: '请求来源或资源访问未获授权' })
  const result = schema.safeParse(input)
  if (!result.success) throw new AppException({ code: 4101, msg: '请求参数格式不正确' })
  return result.data
}
