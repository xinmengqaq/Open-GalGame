import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'

export const suggestedModelAttemptLimit = 16
export const suggestedToolCallLimit = 32
export const suggestedActiveLimitMs = 900000
export const suggestedToolTimeoutMs = 10000
export const suggestedTechnicalRetryCount = 1
export const suggestedTechnicalRetryDelayMs = 60000
export const suggestedContextInputBudgetTokens = 24000
export const suggestedContextSafetyFraction = 0.1
export const suggestedToolResultCharLimit = 8000

const minimumRetryDelayMs = 10000

export interface AgentExecutionOverride {
  modelAttemptLimit?: number
  toolCallLimit?: number
  activeLimitMs?: number
  /** 省略表示本次不设单次工具超时，不用有限数值冒充。 */
  toolTimeoutMs?: number
  technicalRetryCount?: number
  technicalRetryDelayMs?: number
  contextInputBudgetTokens?: number
  contextSafetyFraction?: number
  toolResultCharLimit?: number
  cumulativeTokenLimit?: number
}

export type AgentUserExecutionPreference = AgentExecutionOverride

export interface AgentExecutionProfile {
  modelAttemptLimit: number
  toolCallLimit: number
  activeLimitMs: number
  /** 缺省表示不安装单次工具超时。已给出时必须是正整数。 */
  toolTimeoutMs?: number
  technicalRetryCount: number
  technicalRetryDelayMs: number
  contextInputBudgetTokens: number
  contextSafetyFraction: number
  toolResultCharLimit: number
  cumulativeTokenLimit?: number
}

export interface AgentExecutionAssembly {
  override?: AgentExecutionOverride
  definition?: AgentExecutionOverride
  user?: AgentUserExecutionPreference
}

/**
 * 按本次指定、实现类覆盖、用户级参数、建议默认值组装 Agent 执行配置。
 * @param assembly - 三层可选参数。省略的字段继续向下取值。
 * @throws {AppException} 任一层给出的显式值不合法。非法值不会被默认值替换。
 */
export function assembleAgentExecutionProfile(
  assembly: AgentExecutionAssembly = {}
): AgentExecutionProfile {
  const modelAttemptLimit = pick(assembly, 'modelAttemptLimit', suggestedModelAttemptLimit)
  const toolCallLimit = pick(assembly, 'toolCallLimit', suggestedToolCallLimit)
  const activeLimitMs = pick(assembly, 'activeLimitMs', suggestedActiveLimitMs)
  const explicitToolTimeout = explicitTimeout(assembly)
  const toolTimeoutMs = explicitToolTimeout === null ? undefined : explicitToolTimeout
  const technicalRetryCount = pick(assembly, 'technicalRetryCount', suggestedTechnicalRetryCount)
  const technicalRetryDelayMs = pick(
    assembly,
    'technicalRetryDelayMs',
    suggestedTechnicalRetryDelayMs
  )
  const contextInputBudgetTokens = pick(
    assembly,
    'contextInputBudgetTokens',
    suggestedContextInputBudgetTokens
  )
  const contextSafetyFraction = pick(
    assembly,
    'contextSafetyFraction',
    suggestedContextSafetyFraction
  )
  const toolResultCharLimit = pick(assembly, 'toolResultCharLimit', suggestedToolResultCharLimit)
  const cumulativeTokenLimit = pickOptional(assembly, 'cumulativeTokenLimit')

  requirePositiveInteger(modelAttemptLimit, '模型请求尝试上限必须为正整数')
  requirePositiveInteger(toolCallLimit, '工具调用上限必须为正整数')
  requirePositiveInteger(activeLimitMs, '活跃执行时限必须为正整数')
  if (toolTimeoutMs !== undefined) requirePositiveInteger(toolTimeoutMs, '工具超时必须为正整数')
  requireNonNegativeInteger(technicalRetryCount, '技术重试次数必须为非负整数')
  requirePositiveInteger(technicalRetryDelayMs, '技术重试等待必须为正整数')
  if (technicalRetryDelayMs < minimumRetryDelayMs) {
    throw invalid('技术重试等待不能短于 10 秒')
  }
  requirePositiveInteger(contextInputBudgetTokens, '上下文输入预算必须为正整数')
  if (
    !Number.isFinite(contextSafetyFraction) ||
    contextSafetyFraction <= 0 ||
    contextSafetyFraction >= 1
  ) {
    throw invalid('上下文安全余量必须大于 0 且小于 1')
  }
  requirePositiveInteger(toolResultCharLimit, '工具结果上限必须为正整数')
  if (cumulativeTokenLimit !== undefined) {
    requirePositiveInteger(cumulativeTokenLimit, '累计 token 上限必须为正整数')
  }

  return {
    modelAttemptLimit,
    toolCallLimit,
    activeLimitMs,
    ...(toolTimeoutMs !== undefined ? { toolTimeoutMs } : {}),
    technicalRetryCount,
    technicalRetryDelayMs,
    contextInputBudgetTokens,
    contextSafetyFraction,
    toolResultCharLimit,
    ...(cumulativeTokenLimit !== undefined ? { cumulativeTokenLimit } : {})
  }
}

/**
 * @param fallback - 三层都没有给出时的建议默认值。
 */
function pick(
  assembly: AgentExecutionAssembly,
  key: keyof AgentExecutionOverride,
  fallback: number
): number {
  const value = pickOptional(assembly, key)
  return value === undefined ? fallback : value
}

/**
 * @returns 明确给出的数值；三层都省略时为 undefined。
 */
function pickOptional(
  assembly: AgentExecutionAssembly,
  key: keyof AgentExecutionOverride
): number | undefined {
  if (assembly.override?.[key] !== undefined) return assembly.override[key]
  if (assembly.definition?.[key] !== undefined) return assembly.definition[key]
  return assembly.user?.[key]
}

/**
 * 任一层明确写出工具超时时返回该层的值。
 * 显式 undefined 返回 null，表示不设；三层都没写时返回建议值。
 */
function explicitTimeout(assembly: AgentExecutionAssembly): number | null {
  if (assembly.override !== undefined && 'toolTimeoutMs' in assembly.override) {
    return assembly.override.toolTimeoutMs ?? null
  }
  if (assembly.definition !== undefined && 'toolTimeoutMs' in assembly.definition) {
    return assembly.definition.toolTimeoutMs ?? null
  }
  if (assembly.user !== undefined && 'toolTimeoutMs' in assembly.user) {
    return assembly.user.toolTimeoutMs ?? null
  }
  return suggestedToolTimeoutMs
}

/**
 * @param msg - 失败时的中文说明。
 * @throws {AppException} 数值不是安全的正整数。
 */
function requirePositiveInteger(value: number, msg: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw invalid(msg)
}

/**
 * 拒绝负数和非整数。0 对重试次数是合法的。
 * @param msg - 失败时的中文说明。
 * @throws {AppException} 数值不是安全的非负整数。
 */
function requireNonNegativeInteger(value: number, msg: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw invalid(msg)
}

function invalid(msg: string): AppException {
  return new AppException({ code: ErrorCodes.invalidConfig, msg })
}
