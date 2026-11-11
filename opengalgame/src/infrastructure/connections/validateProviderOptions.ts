import type { ClientOptions as AnthropicClientOptions } from '@anthropic-ai/sdk'
import type { ClientOptions as OpenAIClientOptions } from 'openai'

import { AppException } from '@common/errors/AppException'
import { ConnectionErrorCodes } from '@domain/connections/errors/ConnectionErrorCodes'
import type {
  ConnectionAccess,
  ConnectionExtension
} from '@domain/connections/models/ConnectionSettings'

/**
 * 按供应商取允许写入 SDK 的键。
 * 两组目前相同，是 OpenAI 与 Anthropic 都能接受的交集。
 * 自定义 `User-Agent` 可以放在 `defaultHeaders`，但 LangChain 只会把前缀拼在前面，不能完全替换。
 * 后续供应商分叉时只改对应列表。
 */
const allowedProviderOptionKeys = {
  'openai-compatible': [
    'defaultHeaders',
    'defaultQuery',
    'fetchOptions',
    'logLevel'
  ] as const satisfies readonly (keyof OpenAIClientOptions)[],
  anthropic: [
    'defaultHeaders',
    'defaultQuery',
    'fetchOptions',
    'logLevel'
  ] as const satisfies readonly (keyof AnthropicClientOptions)[]
}

/**
 * 这些键属于 SDK 类型，但会被 LangChain 覆盖、由应用控制，或不能用 JSON 表达。
 * 保留在表里，是为了 SDK 改名时让这里编译失败。
 */
const rejectedProviderOptionKeys = [
  'timeout',
  'maxRetries',
  'apiKey',
  'authToken',
  'baseURL',
  'fetch',
  'dangerouslyAllowBrowser',
  'logger'
] as const satisfies readonly (keyof OpenAIClientOptions | keyof AnthropicClientOptions)[]

const knownRejectedKey: Record<string, true> = {}
for (const key of rejectedProviderOptionKeys) knownRejectedKey[key] = true

const providerLogLevels = ['off', 'error', 'warn', 'info', 'debug'] as const

type AllowedProviderOptionKey =
  | (typeof allowedProviderOptionKeys)['openai-compatible'][number]
  | (typeof allowedProviderOptionKeys.anthropic)[number]

/**
 * 按当前供应商校验扩展对象。允许键从该供应商的表读取，不使用两边的并集。
 * @throws {AppException} 键未知、不会生效，或值不是该键要求的 JSON 形状。消息不含值。
 */
export function validateProviderOptions(
  providerId: ConnectionAccess['providerId'],
  extension: ConnectionExtension
): void {
  const allowedKeySet: Record<string, true> = {}
  for (const key of allowedProviderOptionKeys[providerId]) allowedKeySet[key] = true
  for (const key of Object.keys(extension)) {
    if (!allowedKeySet[key]) throw rejectedKey(key, knownRejectedKey[key] === true)
    validateAllowedValue(key as AllowedProviderOptionKey, extension[key])
  }
}

/** 按键检查值形状。未知键在进入这里之前已经拒绝。 */
function validateAllowedValue(key: AllowedProviderOptionKey, value: unknown): void {
  if (key === 'defaultHeaders' || key === 'defaultQuery') {
    requireStringRecord(value, key)
    return
  }
  if (key === 'fetchOptions') {
    if (!isPlainObject(value)) throw invalidValue(key)
    rejectNonJson(value, key)
    return
  }
  if (!providerLogLevels.includes(value as (typeof providerLogLevels)[number]))
    throw invalidValue(key)
}

/** 键必须非空，值必须是字符串。 */
function requireStringRecord(value: unknown, key: string): void {
  if (!isPlainObject(value)) throw invalidValue(key)
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (entryKey.trim() === '' || typeof entryValue !== 'string') throw invalidValue(key)
  }
}

/**
 * `fetchOptions` 只接受 JSON 可表达的普通对象，拒绝函数、dispatcher 等运行时对象。
 * @throws {AppException} 出现非 JSON 值或危险键。
 */
function rejectNonJson(value: unknown, key: string, seen = new Set<unknown>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalidValue(key)
    return
  }
  if (typeof value !== 'object') throw invalidValue(key)
  if (seen.has(value)) throw invalidValue(key)
  seen.add(value)
  if (Array.isArray(value)) {
    for (const item of value) rejectNonJson(item, key, seen)
    return
  }
  if (!isPlainObject(value)) throw invalidValue(key)
  for (const entryKey of Object.keys(value)) {
    if (entryKey === '__proto__' || entryKey === 'constructor' || entryKey === 'prototype')
      throw rejectedKey(entryKey)
    if (entryKey === 'dispatcher') throw rejectedKey(entryKey)
    rejectNonJson(value[entryKey], key, seen)
  }
}

/** 数组、null 和带自定义原型的对象都不是普通 JSON 对象。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** 点名被拒绝的键，不带用户填写的值。 */
function rejectedKey(key: string, knownIneffective = false): AppException {
  return new AppException({
    code: ConnectionErrorCodes.invalidConnectionConfig,
    msg: knownIneffective
      ? `扩展 JSON 的键 ${key} 由应用控制或不会按填写值生效`
      : `扩展 JSON 的键 ${key} 不能用于当前供应商`
  })
}

/** 点名形状不对的键，不回显值。 */
function invalidValue(key: string): AppException {
  return new AppException({
    code: ConnectionErrorCodes.invalidConnectionConfig,
    msg: `扩展 JSON 的键 ${key} 格式不正确`
  })
}
