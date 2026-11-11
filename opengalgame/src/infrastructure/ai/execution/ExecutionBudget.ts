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

  /**
   * @param usage - 已使用量。省略的字段视为 0。
   * @throws {AppException} 上限不是合法整数，或已使用量为负数。
   */
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

  /**
   * 把上限收紧到给定天花板，不改动已使用量。
   * 调用方原有更紧的上限保持不变。
   */
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

  /**
   * 当前是否已有外层负责的计量。已有时调用方不得再次开始或结算。
   * @returns 计量尚未结束时为 true。
   */
  hasOpenRun(): boolean {
    return this.runStartedAt !== undefined
  }

  /**
   * 开始一段活跃执行。外层已经开始时必须先用 `hasOpenRun` 跳过，不能另开一段。
   * @throws {AppException} 上一段执行还没有结束。
   */
  startRun(now = Date.now()): void {
    if (this.runStartedAt !== undefined) {
      throw failure('执行预算已经在计量')
    }
    this.runStartedAt = now
  }

  /**
   * @throws {AppException} 当前没有开始中的执行。
   */
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

  /**
   * 剩余活跃时间。进行中的执行会把当前时刻也算进去。
   * @returns 剩余毫秒，耗尽后为负数或 0。
   */
  remainingActiveMs(now = Date.now()): number {
    if (this.limits.activeMs >= Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER
    const inflight = this.runStartedAt === undefined ? 0 : Math.max(0, now - this.runStartedAt)
    return this.limits.activeMs - this.consumed.activeMs - inflight
  }

  /**
   * 记录一次实际发生的模型请求。调用前已没有额度时不增加计数。
   * @throws {AppException} 模型请求次数已经用尽。
   */
  consumeModelAttempt(): void {
    this.consumed.modelAttempts += 1
  }

  /**
   * 记录一次实际发生的工具调用。调用前已没有额度时不增加计数。
   * @throws {AppException} 工具调用次数已经用尽。
   */
  consumeToolCall(): void {
    this.consumed.toolCalls += 1
  }

  /** 已确认的失败或无进展次数。正常调用不增加。 */
  get errorAttempts(): number {
    return this.errorAttemptCount
  }

  /**
   * 记录一次已确认的失败或无进展。同一次失败只记一次。
   * @param limit - 允许的错误次数。超过后停止，并保留触发它的原始失败。
   * @param cause - 本次失败。保护异常不会替换这个原因。
   * @throws {ErrorBudgetExhausted} 错误次数已经超过上限。
   */
  consumeErrorAttempt(limit = 8, cause?: unknown): void {
    this.errorAttemptCount += 1
    if (this.errorAttemptCount > limit) throw new ErrorBudgetExhausted(cause)
  }

  /**
   * 累加一次模型返回的 token。未配置上限时只记录，不因此失败。
   * @param tokens - 本次实际用量，必须为非负整数。
   * @throws {AppException} 用量非法，或累加后超过已配置的上限。
   */
  consumeTokens(tokens: number): void {
    this.consumeTokenUsage({ totalTokens: tokens })
  }

  /**
   * 累加一次真实返回的输入、输出或总量。缺失字段不补 0，也不用总量倒推。
   * @throws {AppException} 用量非法，或累加后超过已配置的上限。
   */
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

  /**
   * 确认还能发起模型请求，并且没有超出活跃时间或 token 上限。
   * @throws {AppException} 任一已发生的预算已经耗尽。
   */
  assertModelAvailable(now = Date.now()): void {
    this.assertActive(now)
    this.assertTokens()
  }

  /**
   * 确认还能发起工具调用，并且没有超出活跃时间。
   * @throws {AppException} 工具次数或活跃时间已经耗尽。
   */
  assertToolAvailable(now = Date.now()): void {
    this.assertActive(now)
  }

  /**
   * @throws {AppException} 活跃时间已经用尽。
   */
  assertActive(now = Date.now()): void {
    if (this.limits.activeMs >= Number.MAX_SAFE_INTEGER) return
    if (this.remainingActiveMs(now) <= 0) throw failure('活跃执行时间已用尽')
  }

  /**
   * 确认可选的累计 token 还没有超过上限。
   * @throws {AppException} 已配置上限且用量已经超过。
   */
  private assertTokens(): void {
    if (this.limits.tokens !== undefined && this.consumed.tokens > this.limits.tokens) {
      throw failure('累计 token 已用尽')
    }
  }
}

/**
 * @param msg - 失败说明。
 * @throws {AppException} 数值不是安全的正整数。
 */
function requirePositiveInteger(value: number, msg: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw failure(msg)
}

/**
 * 读取已使用量。省略视为 0，已超过上限的历史用量仍保留。
 * @param value - 调用方传入的已使用量。
 * @throws {AppException} 用量不是非负整数。
 */
function readUsage(value: number | undefined, msg: string): number {
  if (value === undefined) return 0
  if (!Number.isSafeInteger(value) || value < 0) throw failure(msg)
  return value
}
function readOptionalUsage(value: number | undefined, msg: string): number | undefined {
  if (value === undefined) return undefined
  return readUsage(value, msg)
}

/**
 * @returns 请求无法继续的异常。
 */
function failure(msg: string): AppException {
  return new AppException({ code: ErrorCodes.invalidRequest, msg })
}
