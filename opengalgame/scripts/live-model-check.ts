import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'

import { suggestedModelRequestTimeoutMs } from '@infrastructure/ai/config/modelExecutionConfig'
import { LangChainModelFactory } from '@infrastructure/ai/models/LangChainModelFactory'
import type { ConnectionSettingsInfo } from '@domain/connections/models/ConnectionSettings'

const defaultContextWindow = 256000
const defaultMaxOutputTokens = 8192
const liveReplyLimit = 32

/**
 * @param fallback - 留空时使用的正整数。
 * @returns 解析后的数值；非法文本原样交给后续校验。
 */
function integerOrDefault(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback
  return Number(value)
}

/** 可选采样参数。留空表示不传。 */
function optionalNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined
  return Number(value)
}

/**
 * 输出前去掉密钥，避免失败信息把凭据打出来。
 * @param secret - 需要隐藏的密钥。
 */
function redact(value: unknown, secret: string): string {
  return String(value).split(secret).join('[redacted]')
}

/**
 * 断言失败时抛出不含密钥的说明。
 * @param message - 失败说明。
 */
function assertLive(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const env = parseEnv(readFileSync(resolve(process.cwd(), '.env'), 'utf8'))
const providerId = env.OPENGALGAME_PROVIDER_ID
if (providerId !== 'openai-compatible' && providerId !== 'anthropic')
  throw new Error('OPENGALGAME_PROVIDER_ID 只能是 openai-compatible 或 anthropic')

const apiKey = env.OPENGALGAME_API_KEY ?? ''
const contextWindow = integerOrDefault(env.OPENGALGAME_CONTEXT_WINDOW, defaultContextWindow)
const savedMaxOutputTokens = integerOrDefault(
  env.OPENGALGAME_MAX_OUTPUT_TOKENS,
  defaultMaxOutputTokens
)
const configuredTimeout = integerOrDefault(
  env.OPENGALGAME_REQUEST_TIMEOUT_MS,
  suggestedModelRequestTimeoutMs
)
const settings: ConnectionSettingsInfo = {
  providerId,
  baseUrl: env.OPENGALGAME_BASE_URL ?? '',
  apiKey,
  model: env.OPENGALGAME_MODEL ?? '',
  contextWindow,
  maxOutputTokens: savedMaxOutputTokens,
  temperature: optionalNumber(env.OPENGALGAME_TEMPERATURE),
  topP: optionalNumber(env.OPENGALGAME_TOP_P)
}
const calls: Array<{ url: string; init?: RequestInit }> = []
const fetcher: typeof fetch = async (input, init) => {
  calls.push({ url: String(input), init })
  return fetch(input, init)
}

const factory = new LangChainModelFactory(async () => settings, fetcher)
try {
  const configured = await factory.createModel(
    env.OPENGALGAME_REQUEST_TIMEOUT_MS?.trim()
      ? { user: { requestTimeoutMs: configuredTimeout } }
      : undefined
  )
  assertLive(calls.length === 0, '创建模型时不应访问网络')
  assertLive(configured.profile.contextWindow === contextWindow, '上下文窗口没有使用有效配置')
  assertLive(configured.profile.maxOutputTokens === savedMaxOutputTokens, '输出上限被默认值改写')
  assertLive(configured.profile.requestTimeoutMs === configuredTimeout, '请求超时没有使用有效配置')
  assertLive(!JSON.stringify(configured.profile).includes(apiKey), '有效配置包含密钥')
  assertLive(
    !('temperature' in configured.profile) || settings.temperature !== undefined,
    '未配置温度却写入配置'
  )
  assertLive(
    !('topP' in configured.profile) || settings.topP !== undefined,
    '未配置 top-p 却写入配置'
  )

  const created = await factory.createModel({
    user: env.OPENGALGAME_REQUEST_TIMEOUT_MS?.trim()
      ? { requestTimeoutMs: configuredTimeout }
      : undefined,
    override: { maxOutputTokens: liveReplyLimit }
  })
  assertLive(calls.length === 0, '覆盖输出上限时不应访问网络')
  const reply = await created.model.invoke('Reply with only ok')
  assertLive(calls.length === 1, '一次调用不应发出多次请求')
  const call = calls[0]
  assertLive(call !== undefined, '没有发出模型请求')
  const expectedPath = providerId === 'anthropic' ? '/v1/messages' : '/chat/completions'
  assertLive(
    call.url === `${settings.baseUrl.replace(/\/$/, '')}${expectedPath}`,
    '请求地址与协议不一致'
  )
  assertLive(call.init?.redirect === 'error', '请求允许跟随重定向')
  const body = JSON.parse(String(call.init?.body)) as Record<string, unknown>
  assertLive(body.model === settings.model, '请求模型与配置不一致')
  assertLive(body.max_tokens === liveReplyLimit, '请求输出上限不是本次指定值')
  assertLive(
    !('temperature' in body) || settings.temperature !== undefined,
    '请求夹带了未配置的温度'
  )
  assertLive(!('top_p' in body) || settings.topP !== undefined, '请求夹带了未配置的 top-p')
  const headers = new Headers(call.init?.headers)
  const authorization =
    providerId === 'anthropic' ? headers.get('x-api-key') : headers.get('authorization')
  const expectedAuthorization = providerId === 'anthropic' ? apiKey : `Bearer ${apiKey}`
  assertLive(authorization === expectedAuthorization, '鉴权头不是本次配置的密钥')
  assertLive(headers.get('openai-organization') === null, '请求夹带了 OpenAI organization')
  assertLive(headers.get('openai-project') === null, '请求夹带了 OpenAI project')
  assertLive(
    headers.get('authorization') === null || providerId !== 'anthropic',
    'Anthropic 请求夹带了环境 auth token'
  )
  const text =
    typeof reply.content === 'string' ? reply.content.trim() : JSON.stringify(reply.content)
  assertLive(text.length > 0 && text.length <= 80, '模型回复超出本次短输出范围')
  console.log(
    JSON.stringify({
      model: created.profile.model,
      contextWindow: configured.profile.contextWindow,
      savedMaxOutputTokens: configured.profile.maxOutputTokens,
      requestMaxOutputTokens: created.profile.maxOutputTokens,
      requestTimeoutMs: configured.profile.requestTimeoutMs,
      requestCount: calls.length,
      redirect: call.init?.redirect,
      reply: text
    })
  )
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(redact(message, apiKey))
  process.exitCode = 1
}
