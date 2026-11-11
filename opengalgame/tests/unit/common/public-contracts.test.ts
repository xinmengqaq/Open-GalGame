import { describe, expect, it } from 'vitest'

import type { RuntimeConfig } from '@common/config/RuntimeConfig'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes, errorMessages } from '@common/errors/ErrorCodes'

const networkStatusCodes = [200, 400, 403, 409, 500]

describe('全局数字码', () => {
  it('只包含跨页面通用码，且不使用网络状态码', () => {
    expect(ErrorCodes).toEqual({
      success: 2000,
      invalidRequest: 4101,
      forbidden: 4102,
      operationConflict: 4103,
      invalidConfig: 5101,
      communicationFailed: 5102,
      internalError: 5103
    })

    const values = Object.values(ErrorCodes)
    expect(new Set(values).size).toBe(values.length)
    expect(values.filter((code) => networkStatusCodes.includes(code))).toEqual([])
    expect(Math.floor(ErrorCodes.success / 1000)).toBe(2)
    expect(
      [ErrorCodes.invalidRequest, ErrorCodes.forbidden, ErrorCodes.operationConflict].map((code) =>
        Math.floor(code / 100)
      )
    ).toEqual([41, 41, 41])
    expect(
      [ErrorCodes.invalidConfig, ErrorCodes.communicationFailed, ErrorCodes.internalError].map(
        (code) => Math.floor(code / 100)
      )
    ).toEqual([51, 51, 51])
  })

  it('除成功码外，每个通用码都有默认中文', () => {
    expect(errorMessages).toEqual({
      [ErrorCodes.invalidRequest]: '请求参数格式不正确',
      [ErrorCodes.forbidden]: '请求来源或资源访问未获授权',
      [ErrorCodes.operationConflict]: '同一操作标识对应的请求内容不一致',
      [ErrorCodes.invalidConfig]: '应用配置无效',
      [ErrorCodes.communicationFailed]: '与主进程通信失败，操作结果待确认',
      [ErrorCodes.internalError]: '系统异常，操作未完成'
    })
    expect(Object.keys(errorMessages).map(Number)).not.toContain(ErrorCodes.success)
  })
})

describe('AppException', () => {
  it('只保留 code 和 Error.message', () => {
    const error = new AppException({
      code: ErrorCodes.invalidConfig,
      msg: '应用配置无效'
    })

    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('AppException')
    expect(error.code).toBe(5101)
    expect(error.message).toBe('应用配置无效')
    expect(Object.prototype.hasOwnProperty.call(error, 'msg')).toBe(false)
  })

  it('成功码不能用来构造异常', () => {
    expect(() => new AppException({ code: ErrorCodes.success, msg: '操作成功' })).toThrow(
      '成功码不能用于异常'
    )
  })
})

describe('RuntimeConfig', () => {
  it('只有技术字段，不含凭据或连接设置', () => {
    const config: RuntimeConfig = {
      logLevel: 'info',
      logMaxBytes: 1_048_576,
      logRetentionDays: 7,
      requestTimeoutMs: 10_000
    }

    expect(Object.keys(config).sort()).toEqual([
      'logLevel',
      'logMaxBytes',
      'logRetentionDays',
      'requestTimeoutMs'
    ])
  })
})
