import { ErrorCodes } from './ErrorCodes'

export class AppException extends Error {
  readonly code: number
  readonly reason?: string
  readonly diagnosticCategory?:
    | 'sdk'
    | 'streaming'
    | 'context'
    | 'tool'
    | 'structured-output'
    | 'unknown'
    | 'no-progress'
    | 'completion'
    | 'auth'
    | 'request'
    | 'output-truncated'
    | 'missing-structured-result'

  constructor({
    code,
    msg,
    reason,
    cause,
    diagnosticCategory
  }: {
    code: number
    msg: string
    reason?: string
    cause?: unknown
    diagnosticCategory?: AppException['diagnosticCategory']
  }) {
    if (code === ErrorCodes.success) {
      throw new Error('成功码不能用于异常')
    }
    super(msg, cause === undefined ? undefined : { cause })
    this.name = 'AppException'
    this.code = code
    this.reason = reason
    this.diagnosticCategory = diagnosticCategory
  }
}
