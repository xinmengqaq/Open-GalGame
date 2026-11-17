import { ErrorCodes } from './ErrorCodes'

export class AppException extends Error {
  readonly code: number
  /**
   * 可选的结构化失败原因。只给数值码相同、业务含义不同、又要跨进程判别的少数抛点使用；
   * 稳定小驼峰 token，不是可见文案，也不是通用错误模型。同码的其余业务不携带。
   */
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

  /**
   * @param code - 数字错误码。不能使用成功码。
   * @param msg - 可展示的说明，只保存在 `Error.message`。
   * @param reason - 可选的结构化失败原因；跨进程投影，不参与可见文案。
   * @param cause - 可选的内部诊断原因，不跨进程返回或直接记录。
   * @throws {Error} 传入成功码时抛出。成功不是异常。
   */
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
