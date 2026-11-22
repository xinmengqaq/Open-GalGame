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
