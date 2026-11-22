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

function pick(
  assembly: AgentExecutionAssembly,
  key: keyof AgentExecutionOverride,
  fallback: number
): number {
  const value = pickOptional(assembly, key)
  return value === undefined ? fallback : value
}

function pickOptional(
  assembly: AgentExecutionAssembly,
  key: keyof AgentExecutionOverride
): number | undefined {
  if (assembly.override?.[key] !== undefined) return assembly.override[key]
  if (assembly.definition?.[key] !== undefined) return assembly.definition[key]
  return assembly.user?.[key]
}

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

function requirePositiveInteger(value: number, msg: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw invalid(msg)
}

function requireNonNegativeInteger(value: number, msg: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw invalid(msg)
}

function invalid(msg: string): AppException {
  return new AppException({ code: ErrorCodes.invalidConfig, msg })
}
