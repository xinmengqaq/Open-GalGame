import type { z } from 'zod'

import { IpcExceptionHandler } from './errors/IpcExceptionHandler'
import { parseRequest, type IpcRequestAccess } from './RequestSchema'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import { ErrorCodes } from '@common/errors/ErrorCodes'

export interface IpcRequestHandler {
  <TRequest, TData>(
    schema: z.ZodType<TRequest>,
    input: unknown,
    access: IpcRequestAccess,
    message: string | ((data: TData) => string),
    respond: (request: TRequest) => TData | Promise<TData>
  ): Promise<AjaxResult<TData>>
}

export function createRequestHandler(exceptions: IpcExceptionHandler): IpcRequestHandler {
  return (schema, input, access, message, respond) =>
    exceptions.handle({ requestId: access.requestId }, async () => {
      const data = await respond(parseRequest(schema, input, access))
      return {
        code: ErrorCodes.success,
        msg: typeof message === 'string' ? message : message(data),
        data
      }
    })
}
