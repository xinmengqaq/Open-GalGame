import { GraphRecursionError } from '@langchain/langgraph'
import {
  MultipleStructuredOutputsError,
  StructuredOutputParsingError,
  ToolInvocationError
} from 'langchain'

import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import {
  ActiveLimitExceeded,
  AttemptTimedOut,
  CompletionContractViolation,
  ErrorBudgetExhausted,
  FinalizeRequested,
  MissingStructuredResult,
  OutputTruncated
} from '../execution/executionErrors'

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504])
const NON_RETRYABLE_STATUS = new Set([400, 401, 403, 404, 422])

/**
 * @returns 从外到内的错误链，不根据消息文本判断。
 */
export function unwind(error: unknown): unknown[] {
  const chain: unknown[] = []
  const seen = new Set<unknown>()
  const pending = [error]
  while (pending.length > 0) {
    const current = pending.shift()
    if (!current || typeof current !== 'object' || seen.has(current)) continue
    seen.add(current)
    chain.push(current)
    if ('cause' in current) pending.push(current.cause)
    if ('toolError' in current) pending.push(current.toolError)
  }
  return chain
}

/**
 * 判断失败是否属于可自动重试的技术故障。
 * 鉴权、非法参数、取消、预算耗尽和业务异常不重试。
 * @returns 只应在技术重试边界再试一次时为 true。
 */
export function isRetryable(error: unknown): boolean {
  const chain = unwind(error)
  if (chain.some(isStopError)) return false
  const statuses = chain.map(readStatus).filter((status): status is number => status !== undefined)
  if (statuses.some((status) => NON_RETRYABLE_STATUS.has(status))) return false
  if (statuses.some((status) => RETRYABLE_STATUS.has(status))) return true
  if (chain.some((item) => item instanceof AttemptTimedOut)) return true
  return chain.some(isConnectionError)
}

/**
 * 从错误、cause 和响应头取得 Retry-After。多个来源取较长时间，不缩短服务要求。
 * @param error - 失败链的起点。
 * @returns 至少应等待的毫秒；没有依据时为 undefined。
 */
export function readRetryAfterMs(error: unknown, now = Date.now()): number | undefined {
  let wait: number | undefined
  for (const item of unwind(error)) {
    const direct = readDirectRetryAfter(item, now)
    if (direct !== undefined) wait = wait === undefined ? direct : Math.max(wait, direct)
  }
  return wait
}

/**
 * 判断错误是否应停止而不是重试。
 * @returns 取消、活跃时限或已有业务异常时为 true。
 */
function isStopError(error: unknown): boolean {
  if (error instanceof ActiveLimitExceeded || error instanceof AppException) return true
  if (!error || typeof error !== 'object' || !('name' in error)) return false
  return error.name === 'AbortError' || error.name === 'APIUserAbortError'
}

/**
 * @returns 名称或系统错误码表示连接失败时为 true。
 */
function isConnectionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  if (
    'name' in error &&
    (error.name === 'APIConnectionError' || error.name === 'APIConnectionTimeoutError')
  ) {
    return true
  }
  if (!('code' in error)) return false
  return (
    error.code === 'ECONNRESET' ||
    error.code === 'ETIMEDOUT' ||
    error.code === 'EAI_AGAIN' ||
    error.code === 'ENOTFOUND' ||
    error.code === 'ECONNREFUSED'
  )
}

/**
 * @returns 数字状态码；没有时为 undefined。
 */
function readStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('status' in error)) return undefined
  return typeof error.status === 'number' ? error.status : undefined
}

function readDirectRetryAfter(error: unknown, now: number): number | undefined {
  if (!error || typeof error !== 'object') return undefined
  const values: Array<number | undefined> = []
  if (
    'retryAfterMs' in error &&
    typeof error.retryAfterMs === 'number' &&
    error.retryAfterMs >= 0
  ) {
    values.push(error.retryAfterMs)
  }
  if ('headers' in error) values.push(readHeaderRetryAfter(error.headers, now))
  if (
    'response' in error &&
    error.response &&
    typeof error.response === 'object' &&
    'headers' in error.response
  ) {
    values.push(readHeaderRetryAfter(error.response.headers, now))
  }
  return values.reduce<number | undefined>(
    (longest, value) =>
      value === undefined ? longest : longest === undefined ? value : Math.max(longest, value),
    undefined
  )
}

/** 解析 Retry-After 头。数字按秒换算，日期按剩余时间换算。 */
function readHeaderRetryAfter(headers: unknown, now: number): number | undefined {
  if (!headers || typeof headers !== 'object') return undefined
  if ('get' in headers && typeof headers.get === 'function') {
    const value = headers.get('retry-after')
    return parseRetryAfter(typeof value === 'string' ? value : undefined, now)
  }
  if ('retry-after' in headers) {
    const value = headers['retry-after']
    if (typeof value === 'number' || typeof value === 'string')
      return parseRetryAfter(String(value), now)
  }
  return undefined
}

/** 模型调用边界看到的流式解析失败。只在模型请求入口标记，不把任意语法错误当成流式失败。 */
export class ModelStreamParseError extends Error {
  constructor(cause: SyntaxError) {
    super('模型流式响应无法解析', { cause })
    this.name = 'ModelStreamParseError'
  }
}

/**
 * 只把模型请求入口直接抛出的语法错误标成流式解析失败。
 * 工具或其他位置的语法错误保持原样。
 * @returns 已标记的流式解析失败，或原来的错误。
 */
export function observeModelCallFailure(error: unknown): unknown {
  return error instanceof SyntaxError ? new ModelStreamParseError(error) : error
}

/**
 * 判断这次失败是否占用错误预算。
 * 取消、单次超时、活跃期限、图步数保护、无进展、完成契约、输出截断和缺失结构化结果不计数。
 * @param error - 失败链的起点。
 */
export function countsAsErrorAttempt(error: unknown): boolean {
  return !unwind(error).some(
    (item) =>
      item instanceof ErrorBudgetExhausted ||
      item instanceof FinalizeRequested ||
      item instanceof CompletionContractViolation ||
      item instanceof OutputTruncated ||
      item instanceof MissingStructuredResult ||
      item instanceof ActiveLimitExceeded ||
      item instanceof AttemptTimedOut ||
      item instanceof GraphRecursionError ||
      isNamedError(item, [
        'GraphRecursionError',
        'AbortError',
        'APIUserAbortError',
        'FinalizeRequested',
        'CompletionContractViolation',
        'OutputTruncated',
        'MissingStructuredResult'
      ]) ||
      isStructuredChannelProbe(item)
  )
}

export function normalizeAgentError(error: unknown): AppException {
  if (error instanceof ErrorBudgetExhausted) return error
  const chain = unwind(error)
  const existing = chain.find((item): item is AppException => item instanceof AppException)
  if (!existing && chain.some((item) => isGraphRecursion(item))) {
    return new AppException({
      code: ErrorCodes.invalidRequest,
      msg: '图执行步数已达到技术保护上限',
      cause: error,
      diagnosticCategory: 'sdk'
    })
  }
  if (existing) {
    if (existing.diagnosticCategory) return existing
    const category = classifyDiagnosticError(chain)
    if (category === 'unknown') return existing
    return new AppException({
      code: existing.code,
      msg: existing.message,
      cause: error,
      diagnosticCategory: category
    })
  }
  if (chain.some((item) => item instanceof ActiveLimitExceeded)) {
    return new AppException({
      code: ErrorCodes.invalidRequest,
      msg: '活跃执行时间已用尽',
      cause: error,
      diagnosticCategory: 'context'
    })
  }
  if (chain.some((item) => item instanceof AttemptTimedOut)) {
    return new AppException({
      code: ErrorCodes.invalidRequest,
      msg: '单次调用超时',
      cause: error,
      diagnosticCategory: 'sdk'
    })
  }
  if (chain.some(isStructuredOutputError)) {
    return new AppException({
      code: ErrorCodes.invalidRequest,
      msg: '模型输出不符合约定',
      cause: error,
      diagnosticCategory: 'structured-output'
    })
  }
  if (chain.some(isAbort)) {
    return new AppException({
      code: ErrorCodes.invalidRequest,
      msg: '执行已取消',
      cause: error,
      diagnosticCategory: 'unknown'
    })
  }
  const status = chain.map(readStatus).find((item) => item !== undefined)
  if (status === 401 || status === 403) {
    return new AppException({
      code: ErrorCodes.forbidden,
      msg: '模型鉴权失败',
      cause: error,
      diagnosticCategory: 'auth'
    })
  }
  if (status === 400 || status === 404 || status === 422) {
    return new AppException({
      code: ErrorCodes.invalidRequest,
      msg: '模型请求被拒绝',
      cause: error,
      diagnosticCategory: 'request'
    })
  }
  return new AppException({
    code: ErrorCodes.internalError,
    msg: '模型执行失败',
    cause: error,
    diagnosticCategory: classifyDiagnosticError(chain)
  })
}

function classifyDiagnosticError(
  chain: unknown[]
): NonNullable<AppException['diagnosticCategory']> {
  if (
    chain.some(
      (item) => item instanceof StructuredOutputParsingError || isStructuredOutputError(item)
    )
  )
    return 'structured-output'
  if (chain.some((item) => ToolInvocationError.isInstance(item))) return 'tool'
  if (
    chain.some(
      (item) =>
        item instanceof ModelStreamParseError || isNamedError(item, ['ModelStreamParseError'])
    )
  )
    return 'streaming'
  if (
    chain.some((item) =>
      isNamedError(item, ['APIError', 'APIConnectionError', 'APIConnectionTimeoutError'])
    )
  )
    return 'sdk'
  return 'unknown'
}

/** 识别 LangGraph 的图步数保护。不读取错误文本。 */
function isGraphRecursion(error: unknown): boolean {
  return error instanceof GraphRecursionError || isNamedError(error, ['GraphRecursionError'])
}

/** 结构化通道的格式探测失败只用于选路，不是正式生成错误。 */
function isStructuredChannelProbe(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('message' in error) || typeof error.message !== 'string') {
    return false
  }
  return /json_object|json mode|response_format|json_schema/i.test(error.message)
}

function isNamedError(error: unknown, names: readonly string[]): boolean {
  return Boolean(
    error && typeof error === 'object' && 'name' in error && names.includes(String(error.name))
  )
}

/**
 * 识别结构化输出失败。打包后的类名比 instanceof 更稳，仍不看错误文本。
 * @returns 输出无法按约定解析时为 true。
 */
function isStructuredOutputError(error: unknown): boolean {
  if (
    error instanceof StructuredOutputParsingError ||
    error instanceof MultipleStructuredOutputsError
  ) {
    return true
  }
  if (!error || typeof error !== 'object') return false
  const name =
    'name' in error && typeof error.name === 'string' && error.name.length > 0
      ? error.name
      : error.constructor?.name
  return name === 'StructuredOutputParsingError' || name === 'MultipleStructuredOutputsError'
}

/** 判断错误链上的一项是不是调用取消。 */
function isAbort(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error.name === 'AbortError' || error.name === 'APIUserAbortError')
  )
}

/**
 * @returns 非负等待毫秒；无法识别时为 undefined。
 */
function parseRetryAfter(value: string | undefined, now: number): number | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const date = Date.parse(value)
  if (Number.isNaN(date)) return undefined
  return Math.max(0, date - now)
}
