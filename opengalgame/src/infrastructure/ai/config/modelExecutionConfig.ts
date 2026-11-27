import { AppException } from '@common/errors/AppException'
import { ConnectionErrorCodes } from '@domain/settings/connections/errors/ConnectionErrorCodes'
import type { ConnectionSettingsInfo } from '@domain/settings/connections/models/ConnectionSettings'

export const suggestedModelRequestTimeoutMs = 240000

export type SavedModelParameters = Pick<
  ConnectionSettingsInfo,
  'providerId' | 'baseUrl' | 'model' | 'contextWindow' | 'maxOutputTokens' | 'temperature' | 'topP'
>

export interface ModelUserExecutionPreference {
  requestTimeoutMs?: number
}

export interface ModelExecutionOverride {
  requestTimeoutMs?: number
  maxOutputTokens?: number
  temperature?: number
  topP?: number
}

export interface ModelExecutionProfile {
  providerId: ConnectionSettingsInfo['providerId']
  baseUrl: string
  model: string
  contextWindow: number
  maxOutputTokens: number
  requestTimeoutMs?: number
  temperature?: number
  topP?: number
}

export interface ModelExecutionAssembly {
  saved: SavedModelParameters
  user?: ModelUserExecutionPreference
  override?: ModelExecutionOverride
}

export function assembleModelExecutionProfile({
  saved,
  user,
  override
}: ModelExecutionAssembly): ModelExecutionProfile {
  const requestTimeoutMs =
    override !== undefined && 'requestTimeoutMs' in override
      ? override.requestTimeoutMs
      : user?.requestTimeoutMs !== undefined
        ? user.requestTimeoutMs
        : suggestedModelRequestTimeoutMs
  const maxOutputTokens =
    override?.maxOutputTokens !== undefined ? override.maxOutputTokens : saved.maxOutputTokens
  const temperature = override?.temperature !== undefined ? override.temperature : saved.temperature
  const topP = override?.topP !== undefined ? override.topP : saved.topP

  if (requestTimeoutMs !== undefined) {
    requirePositiveInteger(requestTimeoutMs, '单次请求超时必须为正整数')
  }
  requirePositiveInteger(saved.contextWindow, '上下文窗口必须为正整数')
  requirePositiveInteger(maxOutputTokens, '最大输出 token 必须为正整数')
  if (maxOutputTokens > saved.contextWindow)
    throw invalidConfig('最大输出 token 不能超过上下文窗口')
  if (temperature !== undefined && !isUnitInterval(temperature))
    throw invalidConfig('温度必须为 0 到 1 之间的有限数值')
  if (topP !== undefined && !isUnitInterval(topP))
    throw invalidConfig('top-p 必须为 0 到 1 之间的有限数值')
  if (temperature !== undefined && topP !== undefined)
    throw invalidConfig('温度与 top-p 只能填写一个')

  return {
    providerId: saved.providerId,
    baseUrl: saved.baseUrl,
    model: saved.model,
    contextWindow: saved.contextWindow,
    maxOutputTokens,
    ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(topP !== undefined ? { topP } : {})
  }
}

function requirePositiveInteger(value: number, msg: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw invalidConfig(msg)
}

function isUnitInterval(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1
}

function invalidConfig(msg: string): AppException {
  return new AppException({ code: ConnectionErrorCodes.invalidConnectionConfig, msg })
}
