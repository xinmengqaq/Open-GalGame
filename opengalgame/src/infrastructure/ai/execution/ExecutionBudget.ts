import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { ErrorBudgetExhausted } from './executionErrors'

export interface ExecutionBudgetLimits {
  modelAttempts: number
  toolCalls: number
  activeMs: number
  tokens?: number
}

export interface ExecutionBudgetUsage {
  modelAttempts: number
  toolCalls: number
  activeMs: number
  tokens: number
  inputTokens?: number
  outputTokens?: number
}

export interface ExecutionBudgetCeiling {
  modelAttempts?: number
  toolCalls?: number
  activeMs?: number
  tokens?: number
}

export class ExecutionBudget {
  readonly limits: ExecutionBudgetLimits
  private readonly consumed: ExecutionBudgetUsage
  private runStartedAt?: number
  private errorAttemptCount = 0

  constructor(limits: ExecutionBudgetLimits, usage?: Partial<ExecutionBudgetUsage>) {
    requirePositiveInteger(limits.modelAttempts, '模型请求尝试上限必须为正整数')
    requirePositiveInteger(limits.toolCalls, '工具调用上限必须为正整数')
    requirePositiveInteger(limits.activeMs, '活跃执行时限必须为正整数')
    if (limits.tokens !== undefined) {
      requirePositiveInteger(limits.tokens, '累计 token 上限必须为正整数')
    }
    this.limits = { ...limits }
    this.consumed = {
      modelAttempts: readUsage(usage?.modelAttempts, '已使用的模型请求次数无效'),
      toolCalls: readUsage(usage?.toolCalls, '已使用的工具次数无效'),
      activeMs: readUsage(usage?.activeMs, '已使用的活跃时间无效'),
      tokens: readUsage(usage?.tokens, '已使用的 token 无效'),
      ...(usage?.inputTokens === undefined
        ? {}
        : { inputTokens: readUsage(usage.inputTokens, '已使用的输入 token 无效') }),
      ...(usage?.outputTokens === undefined
        ? {}
        : { outputTokens: readUsage(usage.outputTokens, '已使用的输出 token 无效') })
    }
  }

  get usage(): ExecutionBudgetUsage {
    return { ...this.consumed }
  }

  applyCeiling(ceiling: ExecutionBudgetCeiling): void {
    if (ceiling.modelAttempts !== undefined)
      this.limits.modelAttempts = Math.min(this.limits.modelAttempts, ceiling.modelAttempts)
    if (ceiling.toolCalls !== undefined)
      this.limits.toolCalls = Math.min(this.limits.toolCalls, ceiling.toolCalls)
    if (ceiling.activeMs !== undefined) {
      this.limits.activeMs = Math.min(this.limits.activeMs, ceiling.activeMs)
    }
    if (ceiling.tokens !== undefined) {
      this.limits.tokens =
        this.limits.tokens === undefined
          ? ceiling.tokens
          : Math.min(this.limits.tokens, ceiling.tokens)
    }
  }

  hasOpenRun(): boolean {
    return this.runStartedAt !== undefined
  }

  startRun(now = Date.now()): void {
    if (this.runStartedAt !== undefined) {
      throw failure('执行预算已经在计量')
    }
    this.runStartedAt = now
  }

  finishRun(now = Date.now()): void {
    if (this.runStartedAt === undefined) throw failure('执行预算尚未开始计量')
    this.consumed.activeMs += Math.max(0, now - this.runStartedAt)
    this.runStartedAt = undefined
  }

  remainingModelAttempts(): number {
    return this.limits.modelAttempts - this.consumed.modelAttempts
  }

  remainingToolCalls(): number {
    return this.limits.toolCalls - this.consumed.toolCalls
  }

  remainingActiveMs(now = Date.now()): number {
    if (this.limits.activeMs >= Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER
    const inflight = this.runStartedAt === undefined ? 0 : Math.max(0, now - this.runStartedAt)
    return this.limits.activeMs - this.consumed.activeMs - inflight
  }

  consumeModelAttempt(): void {
    this.consumed.modelAttempts += 1
  }

  consumeToolCall(): void {
    this.consumed.toolCalls += 1
  }

  get errorAttempts(): number {
    return this.errorAttemptCount
  }

  consumeErrorAttempt(limit = 8, cause?: unknown): void {
    this.errorAttemptCount += 1
    if (this.errorAttemptCount > limit) throw new ErrorBudgetExhausted(cause)
  }

  consumeTokens(tokens: number): void {
    this.consumeTokenUsage({ totalTokens: tokens })
  }

  consumeTokenUsage(usage: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
  }): void {
    const input = readOptionalUsage(usage.inputTokens, '输入 token 用量无效')
    const output = readOptionalUsage(usage.outputTokens, '输出 token 用量无效')
    const total = readOptionalUsage(usage.totalTokens, 'token 用量无效')
    if (input === undefined && output === undefined && total === undefined) return
    if (input !== undefined) this.consumed.inputTokens = (this.consumed.inputTokens ?? 0) + input
    if (output !== undefined)
      this.consumed.outputTokens = (this.consumed.outputTokens ?? 0) + output
    const consumedTotal =
      total ??
      (input !== undefined && output !== undefined
        ? input + output
        : input !== undefined
          ? input
          : output)
    if (consumedTotal !== undefined) this.consumed.tokens += consumedTotal
    if (this.limits.tokens !== undefined && this.consumed.tokens > this.limits.tokens) {
      throw failure('累计 token 已用尽')
    }
  }

  assertModelAvailable(now = Date.now()): void {
    this.assertActive(now)
    this.assertTokens()
  }

  assertToolAvailable(now = Date.now()): void {
    this.assertActive(now)
  }

  assertActive(now = Date.now()): void {
    if (this.limits.activeMs >= Number.MAX_SAFE_INTEGER) return
    if (this.remainingActiveMs(now) <= 0) throw failure('活跃执行时间已用尽')
  }

  private assertTokens(): void {
    if (this.limits.tokens !== undefined && this.consumed.tokens > this.limits.tokens) {
      throw failure('累计 token 已用尽')
    }
  }
}

function requirePositiveInteger(value: number, msg: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw failure(msg)
}

function readUsage(value: number | undefined, msg: string): number {
  if (value === undefined) return 0
  if (!Number.isSafeInteger(value) || value < 0) throw failure(msg)
  return value
}
function readOptionalUsage(value: number | undefined, msg: string): number | undefined {
  if (value === undefined) return undefined
  return readUsage(value, msg)
}

function failure(msg: string): AppException {
  return new AppException({ code: ErrorCodes.invalidRequest, msg })
}
