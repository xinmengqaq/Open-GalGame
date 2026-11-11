import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'

/** 错误循环保护用尽。与单次超时、活跃期限和图步数保护不是同一类失败。 */
export class ErrorBudgetExhausted extends AppException {
  /**
   * @param cause - 触发保护时的原始失败。不改写该原因。
   */
  constructor(cause?: unknown) {
    super({ code: ErrorCodes.invalidRequest, msg: '错误调用保护次数已用尽', cause })
    this.name = 'ErrorBudgetExhausted'
  }
}

/** 候选已写出或重复读取已到阈值，需要换到收尾节点提交结构化结果。不占用错误预算。 */
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

/** 候选写出后收到完成提示仍未提交结构化结果。不占用错误预算。 */
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

/** 当前响应达到长度上限或含无法执行的工具调用。不占用错误预算，也不重试。 */
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

/** 最终响应既不是截断，也没有结构化结果。不占用错误预算。 */
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

/**
 * 在取消、超时或活跃时限已经触发时抛出对应错误。
 * @throws {ActiveLimitExceeded | AttemptTimedOut | AppException} 信号已中止。
 */
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

/**
 * /**
 * 等待指定毫秒。取消信号会提前结束等待并清理计时器。
 * @param ms - 等待时长。0 或负数立即完成。
 * @param signal - 取消等待的信号。
 * @throws {AppException | ActiveLimitExceeded | AttemptTimedOut} 等待期间信号已中止。
 */
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
