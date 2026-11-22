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
} from './executionErrors'

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504])
const NON_RETRYABLE_STATUS = new Set([400, 401, 403, 404, 422])

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

export function isRetryable(error: unknown): boolean {
  const chain = unwind(error)
  if (chain.some(isStopError)) return false
  const statuses = chain.map(readStatus).filter((status): status is number => status !== undefined)
  if (statuses.some((status) => NON_RETRYABLE_STATUS.has(status))) return false
  if (statuses.some((status) => RETRYABLE_STATUS.has(status))) return true
  if (chain.some((item) => item instanceof AttemptTimedOut)) return true
  return chain.some(isConnectionError)
}

export function readRetryAfterMs(error: unknown, now = Date.now()): number | undefined {
  let wait: number | undefined
  for (const item of unwind(error)) {
    const direct = readDirectRetryAfter(item, now)
    if (direct !== undefined) wait = wait === undefined ? direct : Math.max(wait, direct)
  }
  return wait
}

function isStopError(error: unknown): boolean {
  if (error instanceof ActiveLimitExceeded || error instanceof AppException) return true
  if (!error || typeof error !== 'object' || !('name' in error)) return false
  return error.name === 'AbortError' || error.name === 'APIUserAbortError'
}

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

export class ModelStreamParseError extends Error {
  constructor(cause: SyntaxError) {
    super('模型流式响应无法解析', { cause })
    this.name = 'ModelStreamParseError'
  }
}

export function observeModelCallFailure(error: unknown): unknown {
  return error instanceof SyntaxError ? new ModelStreamParseError(error) : error
}

/**
 * 判断这次失败是否占用错误预算。
 * 取消、单次超时、活跃期限、无进展、完成契约、输出截断和缺失结构化结果不计数。
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
      isNamedError(item, [
        'AbortError',
        'APIUserAbortError',
        'FinalizeRequested',
        'CompletionContractViolation',
        'OutputTruncated',
        'MissingStructuredResult'
      ])
  )
}

export function normalizeAgentError(error: unknown): AppException {
  if (error instanceof ErrorBudgetExhausted) return error
  const chain = unwind(error)
  const existing = chain.find((item): item is AppException => item instanceof AppException)
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

function isNamedError(error: unknown, names: readonly string[]): boolean {
  return Boolean(
    error && typeof error === 'object' && 'name' in error && names.includes(String(error.name))
  )
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

function parseRetryAfter(value: string | undefined, now: number): number | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const date = Date.parse(value)
  if (Number.isNaN(date)) return undefined
  return Math.max(0, date - now)
}
