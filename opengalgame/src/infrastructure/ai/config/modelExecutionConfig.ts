import { AppException } from '@common/errors/AppException'
import { ConnectionErrorCodes } from '@domain/connections/errors/ConnectionErrorCodes'
import type { ConnectionSettingsInfo } from '@domain/connections/models/ConnectionSettings'

/** 单次生成请求的建议超时。只在用户级和本次指定都没有超时时使用。 */
export const suggestedModelRequestTimeoutMs = 240000

/** 已保存连接设置中参与模型构造的字段，不含密钥。 */
export type SavedModelParameters = Pick<
  ConnectionSettingsInfo,
  'providerId' | 'baseUrl' | 'model' | 'contextWindow' | 'maxOutputTokens' | 'temperature' | 'topP'
>

/** 调用方持有的用户级执行参数。当前存储没有生成请求超时。 */
export interface ModelUserExecutionPreference {
  requestTimeoutMs?: number
}

/** 本次调用明确指定的参数，优先于已保存设置和用户级参数。 */
export interface ModelExecutionOverride {
  /** 省略表示本次不设单次请求超时，不用有限数值冒充。 */
  requestTimeoutMs?: number
  maxOutputTokens?: number
  temperature?: number
  topP?: number
}

/**
 * 不含密钥、可随执行说明保存的有效模型配置。
 * 只记录协议、模型名称和已配置的窗口、输出与采样，不表示这些能力已经探测通过。
 */
export interface ModelExecutionProfile {
  providerId: ConnectionSettingsInfo['providerId']
  baseUrl: string
  model: string
  contextWindow: number
  maxOutputTokens: number
  /** 缺省表示不安装单次请求超时。已给出时必须是正整数。 */
  requestTimeoutMs?: number
  temperature?: number
  topP?: number
}

export interface ModelExecutionAssembly {
  saved: SavedModelParameters
  user?: ModelUserExecutionPreference
  override?: ModelExecutionOverride
}

/**
 * 按本次指定、用户级参数、建议默认值的顺序组装模型执行配置。
 * @param assembly - 已保存的无密钥参数，以及可选的用户级超时和本次覆盖。
 * @throws {AppException} 超时、输出上限或采样参数不合法，或合并后温度与 top-p 冲突。
 */
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

/**
 * @param msg - 失败时展示的中文说明。
 * @throws {AppException} 数值不是安全的正整数。
 */
function requirePositiveInteger(value: number, msg: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw invalidConfig(msg)
}

/** 判断采样参数是否落在现有约定的闭区间。 */
function isUnitInterval(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1
}

/**
 * @param msg - 可展示的中文说明，不包含密钥或请求内容。
 */
function invalidConfig(msg: string): AppException {
  return new AppException({ code: ConnectionErrorCodes.invalidConnectionConfig, msg })
}
