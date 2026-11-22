import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'

export class ErrorBudgetExhausted extends AppException {
  constructor(cause?: unknown) {
    super({ code: ErrorCodes.invalidRequest, msg: '错误调用保护次数已用尽', cause })
    this.name = 'ErrorBudgetExhausted'
  }
}

export class FinalizeRequested extends AppException {
  readonly causeKind: 'noNewInformation' | 'postWriteNoSubmission'

  constructor(causeKind: FinalizeRequested['causeKind']) {
    super({
      code: ErrorCodes.operationConflict,
      msg: '需要收尾提交结构化结果',
      diagnosticCategory: 'no-progress'
    })
    this.name = 'FinalizeRequested'
    this.causeKind = causeKind
  }
}

export class CompletionContractViolation extends AppException {
  constructor(cause?: unknown) {
    super({
      code: ErrorCodes.operationConflict,
      msg: '收到完成提示后仍未提交结构化结果，本次生成已停止',
      cause,
      diagnosticCategory: 'completion'
    })
    this.name = 'CompletionContractViolation'
  }
}

export class OutputTruncated extends AppException {
  constructor(cause?: unknown) {
    super({
      code: ErrorCodes.invalidRequest,
      msg: '模型输出达到长度上限，本次生成未完成',
      cause,
      diagnosticCategory: 'output-truncated'
    })
    this.name = 'OutputTruncated'
  }
}

export class MissingStructuredResult extends AppException {
  constructor(cause?: unknown) {
    super({
      code: ErrorCodes.invalidRequest,
      msg: '模型没有提交结构化结果',
      cause,
      diagnosticCategory: 'missing-structured-result'
    })
    this.name = 'MissingStructuredResult'
  }
}

export class ActiveLimitExceeded extends Error {
  constructor(cause?: unknown) {
    super('活跃执行时间已用尽', cause === undefined ? undefined : { cause })
    this.name = 'ActiveLimitExceeded'
  }
}

export class AttemptTimedOut extends Error {
  constructor() {
    super('单次调用超时')
    this.name = 'AttemptTimedOut'
  }
}

export function throwIfStopped(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const reason = signal.reason
  if (
    reason instanceof ActiveLimitExceeded ||
    reason instanceof AttemptTimedOut ||
    reason instanceof AppException
  ) {
    throw reason
  }
  throw new AppException({ code: ErrorCodes.invalidRequest, msg: '执行已取消', cause: reason })
}

export function waitWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfStopped(signal)
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      try {
        throwIfStopped(signal)
        resolve()
      } catch (error) {
        reject(error)
      }
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
