import { describe, expect, it } from 'vitest'

import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { LogContext } from '@common/logging/LogContext'
import type { LoggerGateway } from '@common/logging/LoggerGateway'
import { communicationFailureResult } from '@interfaces/client/communicationFailure'
import { IpcErrorMapper } from '@interfaces/ipc/errors/IpcErrorMapper'
import { IpcExceptionHandler } from '@interfaces/ipc/errors/IpcExceptionHandler'

interface LogCall {
  level: string
  event: string
  context?: LogContext
}

function createLogger(): { logger: LoggerGateway; calls: LogCall[] } {
  const calls: LogCall[] = []
  const logger: LoggerGateway = {
    debug(event, context) {
      calls.push({ level: 'debug', event, context })
    },
    info(event, context) {
      calls.push({ level: 'info', event, context })
    },
    warn(event, context) {
      calls.push({ level: 'warn', event, context })
    },
    error(event, context) {
      calls.push({ level: 'error', event, context })
    }
  }
  return { logger, calls }
}

describe('IpcErrorMapper', () => {
  const mapper = new IpcErrorMapper()

  it('原样保留调用方的数字码和消息，不把局部码改成 5103', () => {
    const error = new AppException({
      code: 1306,
      msg: '工程已保存，但项目登记失败，请重试登记'
    })

    expect(mapper.map(error)).toEqual({
      code: 1306,
      msg: '工程已保存，但项目登记失败，请重试登记'
    })
  })

  it('未知异常变成 5103，且不带回原文或调用栈', () => {
    const error = new Error('C:\\Users\\secret\\api-key.txt')
    error.stack = 'Error: C:\\Users\\secret\\api-key.txt\n    at readSecret'

    const result = mapper.map(error)
    const body = JSON.stringify(result)

    expect(result).toEqual({
      code: ErrorCodes.internalError,
      msg: '系统异常，操作未完成'
    })
    expect(body).not.toContain('secret')
    expect(body).not.toContain('api-key')
    expect(body).not.toContain('readSecret')
    expect(mapper.map('boom')).toEqual(result)
  })
})

describe('IpcExceptionHandler', () => {
  it('直接返回的取消和业务失败都不改写、不记失败', async () => {
    const { logger, calls } = createLogger()
    const handler = new IpcExceptionHandler(logger)
    const context = { requestId: 'req-1', operationId: 'op-1' }

    const cancelled = await handler.handle(context, () => ({
      code: ErrorCodes.success,
      msg: '已取消选择',
      data: { status: 'cancelled' as const }
    }))
    const rejected = await handler.handle(context, () => ({
      code: 1101,
      msg: '项目名称不能为空'
    }))

    expect(cancelled).toEqual({
      code: 2000,
      msg: '已取消选择',
      data: { status: 'cancelled' }
    })
    expect(rejected).toEqual({ code: 1101, msg: '项目名称不能为空' })
    expect(calls).toEqual([])
  })

  it('抛出的异常只记录一次，且日志不含消息正文', async () => {
    const { logger, calls } = createLogger()
    const handler = new IpcExceptionHandler(logger)

    const result = await handler.handle({ requestId: 'req-1', operationId: 'op-1' }, async () => {
      throw new AppException({ code: 1101, msg: '项目名称不能为空' })
    })

    expect(result).toEqual({ code: 1101, msg: '项目名称不能为空' })
    expect(calls).toEqual([
      {
        level: 'error',
        event: '请求执行失败',
        context: { requestId: 'req-1', operationId: 'op-1', errorCode: 1101 }
      }
    ])
    expect(JSON.stringify(calls)).not.toContain('项目名称')
  })

  it('没有 operationId 时日志不补这个字段', async () => {
    const { logger, calls } = createLogger()
    const handler = new IpcExceptionHandler(logger)

    await handler.handle({ requestId: 'req-2' }, () => {
      throw new AppException({ code: ErrorCodes.invalidRequest, msg: '请求参数格式不正确' })
    })

    expect(calls[0]?.context).toEqual({ requestId: 'req-2', errorCode: 4101 })
  })

  it('捕获到的失败一律记 error，不按错误码区分级别', async () => {
    const codes = [1101, 1306, 4201, 4301, ErrorCodes.invalidRequest, ErrorCodes.internalError]
    for (const code of codes) {
      const { logger, calls } = createLogger()
      const handler = new IpcExceptionHandler(logger)
      await handler.handle({ requestId: `req-${code}` }, () => {
        throw new AppException({ code, msg: '安全消息' })
      })
      expect(calls).toEqual([
        {
          level: 'error',
          event: '请求执行失败',
          context: { requestId: `req-${code}`, errorCode: code }
        }
      ])
      expect(JSON.stringify(calls)).not.toContain('安全消息')
    }
  })

  it('日志写入失败仍返回映射结果', async () => {
    const logger: LoggerGateway = {
      debug() {
        return undefined
      },
      info() {
        return undefined
      },
      warn() {
        return undefined
      },
      error() {
        throw new Error('log failed')
      }
    }
    const handler = new IpcExceptionHandler(logger)

    const result = await handler.handle({ requestId: 'req-3' }, () => {
      throw new AppException({
        code: ErrorCodes.invalidConfig,
        msg: '应用配置无效'
      })
    })

    expect(result).toEqual({
      code: 5101,
      msg: '应用配置无效'
    })
  })
})

describe('通信失败', () => {
  it('本地记为 5102，响应只包含安全错误信息', () => {
    expect(communicationFailureResult()).toEqual({
      code: ErrorCodes.communicationFailed,
      msg: '与主进程通信失败，操作结果待确认'
    })
  })
})
