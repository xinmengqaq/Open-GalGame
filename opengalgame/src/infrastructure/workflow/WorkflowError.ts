import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'

export type WorkflowErrorCategory =
  | 'cancelled'
  | 'timedOut'
  | 'checkpointCorrupt'
  | 'checkpointIncompatible'
  | 'recoveryBasisMissing'
  | 'interrupted'
  | 'effectResultUnknown'
  | 'executionFailed'
  | 'cleanupFailed'

const CATEGORY_CODE: Record<WorkflowErrorCategory, number> = {
  cancelled: ErrorCodes.invalidRequest,
  timedOut: ErrorCodes.invalidRequest,
  checkpointCorrupt: ErrorCodes.internalError,
  checkpointIncompatible: ErrorCodes.invalidConfig,
  recoveryBasisMissing: ErrorCodes.invalidRequest,
  interrupted: ErrorCodes.invalidRequest,
  effectResultUnknown: ErrorCodes.invalidRequest,
  executionFailed: ErrorCodes.internalError,
  cleanupFailed: ErrorCodes.internalError
}

export class WorkflowError extends AppException {
  readonly category: WorkflowErrorCategory
  readonly settlementError?: unknown
  readonly completed?: readonly string[]

  /**
   * @param category - 技术失败类别。不根据错误文本区分业务结果。
   * @param cause - 原始失败。
   * @param code - 覆盖默认错误码，例如路径越界使用拒绝码。
   * @param settlementError - 预算结算失败。与执行失败同时保留。
   */
  constructor({
    category,
    msg,
    cause,
    code,
    settlementError,
    completed
  }: {
    category: WorkflowErrorCategory
    msg: string
    cause?: unknown
    code?: number
    settlementError?: unknown
    completed?: readonly string[]
  }) {
    super({ code: code ?? CATEGORY_CODE[category], msg, cause })
    this.name = 'WorkflowError'
    this.category = category
    this.settlementError = settlementError
    this.completed = completed
  }
}
