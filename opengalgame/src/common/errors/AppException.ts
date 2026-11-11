import { ErrorCodes } from './ErrorCodes'

export class AppException extends Error {
  readonly code: number
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

  /**
   * @param code - 数字错误码。不能使用成功码。
   * @param msg - 可展示的说明，只保存在 `Error.message`。
   * @param cause - 可选的内部诊断原因，不跨进程返回或直接记录。
   * @throws {Error} 传入成功码时抛出。成功不是异常。
   */
  constructor({
    code,
    msg,
    cause,
    diagnosticCategory
  }: {
    code: number
    msg: string
    cause?: unknown
    diagnosticCategory?: AppException['diagnosticCategory']
  }) {
    if (code === ErrorCodes.success) {
      throw new Error('成功码不能用于异常')
    }
    super(msg, cause === undefined ? undefined : { cause })
    this.name = 'AppException'
    this.code = code
    this.diagnosticCategory = diagnosticCategory
  }
}
