import type { z } from 'zod'

import { IpcExceptionHandler } from './errors/IpcExceptionHandler'
import { parseRequest, type IpcRequestAccess } from './RequestSchema'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import { ErrorCodes } from '@common/errors/ErrorCodes'

/** 一个通道的请求处理：解析、执行用例并包装成功响应，失败交由统一出口映射。 */
export interface IpcRequestHandler {
  <TRequest, TData>(
    schema: z.ZodType<TRequest>,
    input: unknown,
    access: IpcRequestAccess,
    message: string,
    respond: (request: TRequest) => TData | Promise<TData>
  ): Promise<AjaxResult<TData>>
}

/**
 * @param exceptions - 统一失败出口。
 * @returns 可直接调用的请求处理函数。
 */
export function createRequestHandler(exceptions: IpcExceptionHandler): IpcRequestHandler {
  return (schema, input, access, message, respond) =>
    exceptions.handle({ requestId: access.requestId }, async () => ({
      code: ErrorCodes.success,
      msg: message,
      data: await respond(parseRequest(schema, input, access))
    }))
}
