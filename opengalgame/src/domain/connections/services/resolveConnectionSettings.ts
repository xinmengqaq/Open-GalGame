import { ConnectionErrorCodes } from '../errors/ConnectionErrorCodes'
import type {
  ConnectionAccess,
  ConnectionExtension,
  ConnectionSettingsInfo
} from '../models/ConnectionSettings'
import { AppException } from '@common/errors/AppException'

export interface ConnectionAccessRequest {
  input: {
    providerId: 'openai-compatible' | 'anthropic'
    baseUrl: string
    apiKey: { kind: 'keep' } | { kind: 'replace'; value: string }
    extension: { kind: 'keep' } | { kind: 'set'; value: string } | { kind: 'clear' }
  }
  current: ConnectionAccess | null
}

export interface ConnectionResolutionRequest {
  input: ConnectionAccessRequest['input'] & {
    model: string
    contextWindow: number
    maxOutputTokens: number
    temperature?: number
    topP?: number
  }
  current: ConnectionSettingsInfo | null
}

/**
 * 解析协议、地址与密钥，供拉取上游模型列表使用。
 * @returns 主进程内部使用的访问凭据。
 * @throws {AppException} 地址或密钥不合法，或更换地址仍要求保留旧凭据。
 */
export function resolveConnectionAccess({
  input,
  current
}: ConnectionAccessRequest): ConnectionAccess {
  const url = URL.parse(input.baseUrl.trim())
  if (!url)
    throw new AppException({
      code: ConnectionErrorCodes.invalidConnectionConfig,
      msg: '请输入有效的模型服务地址'
    })
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new AppException({
      code: ConnectionErrorCodes.invalidConnectionConfig,
      msg: '连接配置格式不正确，地址不能携带凭据或查询参数'
    })
  const baseUrl = url.href.replace(/\/+$/, '')
  let apiKey: string
  if (input.apiKey.kind === 'replace') {
    apiKey = input.apiKey.value.trim()
  } else {
    if (!current || current.baseUrl !== baseUrl || current.providerId !== input.providerId)
      throw new AppException({
        code: ConnectionErrorCodes.invalidConnectionConfig,
        msg: '首次配置或更换协议、服务地址时，请填写新的 API Key'
      })
    apiKey = current.apiKey
  }
  if (!apiKey)
    throw new AppException({
      code: ConnectionErrorCodes.invalidConnectionConfig,
      msg: 'API Key 不能为空'
    })
  return { providerId: input.providerId, baseUrl, apiKey }
}

/**
 * 按地址与凭据保留规则解析当前设置。
 * @returns 可供测试或保存的内部设置，不用于界面响应。
 * @throws {AppException} 配置内容非法，或更换地址仍要求保留旧凭据。
 */
export function resolveConnectionSettings({
  input,
  current
}: ConnectionResolutionRequest): ConnectionSettingsInfo {
  const access = resolveConnectionAccess({ input, current })
  const model = input.model.trim()
  if (!model)
    throw new AppException({
      code: ConnectionErrorCodes.invalidConnectionConfig,
      msg: '模型名称不能为空'
    })
  if (!Number.isSafeInteger(input.contextWindow) || input.contextWindow <= 0)
    throw new AppException({
      code: ConnectionErrorCodes.invalidConnectionConfig,
      msg: '上下文窗口必须为正整数'
    })
  if (!Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens <= 0)
    throw new AppException({
      code: ConnectionErrorCodes.invalidConnectionConfig,
      msg: '最大输出 token 必须为正整数'
    })
  if (input.maxOutputTokens > input.contextWindow)
    throw new AppException({
      code: ConnectionErrorCodes.invalidConnectionConfig,
      msg: '最大输出 token 不能超过上下文窗口'
    })
  if (
    input.temperature !== undefined &&
    (!Number.isFinite(input.temperature) || input.temperature < 0 || input.temperature > 1)
  )
    throw new AppException({
      code: ConnectionErrorCodes.invalidConnectionConfig,
      msg: '温度必须为 0 到 1 之间的有限数值'
    })
  if (
    input.topP !== undefined &&
    (!Number.isFinite(input.topP) || input.topP < 0 || input.topP > 1)
  )
    throw new AppException({
      code: ConnectionErrorCodes.invalidConnectionConfig,
      msg: 'top-p 必须为 0 到 1 之间的有限数值'
    })
  if (input.temperature !== undefined && input.topP !== undefined)
    throw new AppException({
      code: ConnectionErrorCodes.invalidConnectionConfig,
      msg: '温度与 top-p 只能填写一个'
    })
  return {
    ...access,
    model,
    contextWindow: input.contextWindow,
    maxOutputTokens: input.maxOutputTokens,
    temperature: input.temperature,
    topP: input.topP,
    ...extensionField(resolveConnectionExtension(input.extension, current?.extension))
  }
}

/** 没有扩展时不写字段，避免把“未配置”和空对象混在一起。 */
function extensionField(
  extension: ConnectionExtension | undefined
): { extension: ConnectionExtension } | Record<string, never> {
  return extension === undefined ? {} : { extension }
}

/** 扩展 JSON 明文上限。按 UTF-8 字节计，超过即拒绝，不保存截断结果。 */
export const connectionExtensionMaxBytes = 8 * 1024

const dangerousExtensionKeys: Record<string, true> = Object.create(null)
for (const key of ['__proto__', 'constructor', 'prototype'])
  Object.defineProperty(dangerousExtensionKeys, key, { value: true })

/**
 * 解析扩展 JSON 的保留、替换和清空。
 * @returns 没有扩展时省略该字段；清空时也不保留旧对象。
 * @throws {AppException} JSON 不是普通对象、超过字节上限，或含危险键。
 */
export function resolveConnectionExtension(
  input: ConnectionAccessRequest['input']['extension'],
  current: ConnectionExtension | undefined
): ConnectionExtension | undefined {
  if (input.kind === 'keep') return current
  if (input.kind === 'clear') return undefined
  return parseConnectionExtension(input.value)
}

/**
 * 只检查 JSON 结构，不解释供应商配置项。
 * @throws {AppException} 语法、形状、大小或危险键不合法。消息不含原文。
 */
function parseConnectionExtension(value: string): ConnectionExtension {
  const bytes = Buffer.byteLength(value, 'utf8')
  if (bytes > connectionExtensionMaxBytes)
    throw new AppException({
      code: ConnectionErrorCodes.invalidConnectionConfig,
      msg: `扩展 JSON 不能超过 ${connectionExtensionMaxBytes} 字节`
    })
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new AppException({
      code: ConnectionErrorCodes.invalidConnectionConfig,
      msg: '扩展 JSON 格式不正确'
    })
  }
  if (!isPlainObject(parsed))
    throw new AppException({
      code: ConnectionErrorCodes.invalidConnectionConfig,
      msg: '扩展 JSON 必须是对象'
    })
  rejectDangerousExtensionKeys(parsed)
  return parsed
}

/** 数组、null 和带原型的对象都不能当作扩展配置。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * 递归拒绝会污染对象原型的键。只点名键名。
 * @throws {AppException} 任一深度出现危险键。
 */
function rejectDangerousExtensionKeys(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) rejectDangerousExtensionKeys(item)
    return
  }
  if (!isPlainObject(value)) return
  for (const key of Object.keys(value)) {
    if (dangerousExtensionKeys[key])
      throw new AppException({
        code: ConnectionErrorCodes.invalidConnectionConfig,
        msg: `扩展 JSON 不能包含键 ${key}`
      })
    rejectDangerousExtensionKeys(value[key])
  }
}
