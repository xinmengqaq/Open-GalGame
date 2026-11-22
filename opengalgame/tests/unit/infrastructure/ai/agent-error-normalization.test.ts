import { describe, expect, it } from 'vitest'

import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import {
  CompletionContractViolation,
  ErrorBudgetExhausted,
  MissingStructuredResult,
  OutputTruncated
} from '@infrastructure/ai/execution/executionErrors'
import {
  ModelStreamParseError,
  countsAsErrorAttempt,
  normalizeAgentError
} from '@infrastructure/ai/execution/agentError'

describe('Agent 技术失败分类', () => {
  it('错误预算耗尽保留业务异常，不改成通用执行失败', () => {
    const budget = normalizeAgentError(new ErrorBudgetExhausted(new Error('model down')))

    expect(budget.message).toBe('错误调用保护次数已用尽')
    expect(budget.cause).toBeInstanceOf(Error)
    expect(budget.diagnosticCategory).toBeUndefined()
  })

  it('普通语法错误不是流式失败，模型流解析和已有诊断分类按实际结构保留', () => {
    const syntax = normalizeAgentError(new SyntaxError('文件内容不是 JSON'))
    const stream = normalizeAgentError(new ModelStreamParseError(new SyntaxError('bad sse')))
    const wrapped = normalizeAgentError(
      new AppException({
        code: ErrorCodes.internalError,
        msg: '模型执行失败',
        cause: new ModelStreamParseError(new SyntaxError('wrapped sse'))
      })
    )
    const classified = new AppException({
      code: ErrorCodes.forbidden,
      msg: '模型鉴权失败',
      diagnosticCategory: 'auth'
    })

    expect(syntax).toMatchObject({
      code: ErrorCodes.internalError,
      message: '模型执行失败',
      diagnosticCategory: 'unknown'
    })
    expect(stream.diagnosticCategory).toBe('streaming')
    expect(wrapped.message).toBe('模型执行失败')
    expect(wrapped.code).toBe(ErrorCodes.internalError)
    expect(wrapped.diagnosticCategory).toBe('streaming')
    expect(normalizeAgentError(classified)).toBe(classified)
  })

  it('鉴权和请求拒绝保留原错误码，并按状态分类', () => {
    const denied = Object.assign(new Error('provider denied'), { status: 401 })
    const rejected = Object.assign(new Error('provider rejected'), { status: 422 })
    const auth = normalizeAgentError(denied)
    const request = normalizeAgentError(rejected)

    expect(auth).toMatchObject({
      code: ErrorCodes.forbidden,
      message: '模型鉴权失败',
      diagnosticCategory: 'auth'
    })
    expect(request).toMatchObject({
      code: ErrorCodes.invalidRequest,
      message: '模型请求被拒绝',
      diagnosticCategory: 'request'
    })
    expect(auth.message).not.toContain('provider denied')
    expect(request.message).not.toContain('provider rejected')
  })

  it('已有诊断分类的异常原样保留，截断和缺失结果不占错误预算', () => {
    const truncated = new OutputTruncated()
    const missing = new MissingStructuredResult()
    const completion = new CompletionContractViolation()

    expect(normalizeAgentError(truncated)).toBe(truncated)
    expect(normalizeAgentError(missing)).toBe(missing)
    expect(countsAsErrorAttempt(truncated)).toBe(false)
    expect(countsAsErrorAttempt(missing)).toBe(false)
    expect(countsAsErrorAttempt(completion)).toBe(false)
    expect(truncated).toMatchObject({
      code: ErrorCodes.invalidRequest,
      message: '模型输出达到长度上限，本次生成未完成',
      diagnosticCategory: 'output-truncated'
    })
    expect(missing).toMatchObject({
      message: '模型没有提交结构化结果',
      diagnosticCategory: 'missing-structured-result'
    })
  })
})
