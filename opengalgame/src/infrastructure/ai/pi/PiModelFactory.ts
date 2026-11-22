import type {
  Api,
  AssistantMessageEventStream,
  Model,
  SimpleStreamOptions,
  TranscriptContext
} from '@earendil-works/pi-ai'
import type { StreamFn } from '@earendil-works/pi-agent-core'

import { AppException } from '@common/errors/AppException'
import { ConnectionErrorCodes } from '@domain/connections/errors/ConnectionErrorCodes'
import type { ConnectionSettingsInfo } from '@domain/connections/models/ConnectionSettings'
import { validateProviderOptions } from '@infrastructure/connections/validateProviderOptions'

import {
  assembleModelExecutionProfile,
  type ModelExecutionOverride,
  type ModelExecutionProfile,
  type ModelUserExecutionPreference
} from '../config/modelExecutionConfig'
import { guardStreamIdle } from '../models/streamIdleGuard'

/** 本次创建模型时可选的用户级参数和本次覆盖。 */
export interface PiModelCreationRequest {
  user?: ModelUserExecutionPreference
  override?: ModelExecutionOverride
}

/** Pi 模型及其不含密钥的有效配置和执行入口。 */
export interface PiModelRuntime {
  /** 不包含密钥；`baseUrl` 和模型元数据可随执行说明保存。 */
  model: Model<Api>
  profile: ModelExecutionProfile
  /** 由已保存连接设置绑定密钥、fetch、超时和重试策略的流函数。 */
  streamFn: StreamFn
  /**
   * 最近一次模型 HTTP 响应的非成功状态码；每次模型运行时独立记录。
   * Pi 的流适配器只保留可展示的失败文案，不保留状态码，执行入口据此恢复分类。
   */
  readonly lastHttpStatus?: () => number | undefined
}

type PiStreamSimple = (
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions
) => AssistantMessageEventStream

/**
 * 按产品连接设置创建 Pi 模型运行时。
 *
 * 密钥只在本次闭包内使用：不进入返回的模型、配置或错误文案。
 * 不用进程环境变量补足缺失密钥；`loadSettings` 返回什么就使用什么。
 */
export class PiModelFactory {
  private readonly streams = new Map<'openai-compatible' | 'anthropic', Promise<PiStreamSimple>>()

  /**
   * @param loadSettings - 读取已保存的完整连接设置。没有可用设置时返回 null。
   * @param fetcher - 可选 fetch。测试注入替身；默认使用全局 fetch。
   */
  constructor(
    private readonly loadSettings: () => Promise<ConnectionSettingsInfo | null>,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  /**
   * 读取已保存设置并构造模型运行时。构造过程不访问网络。
   * @param request - 用户级超时和本次覆盖。省略时沿用已保存参数和建议默认超时。
   * @throws {AppException} 没有可用设置、密钥为空、扩展或执行参数不合法。
   */
  async create(request: PiModelCreationRequest = {}): Promise<PiModelRuntime> {
    const settings = await this.loadSettings()
    if (!settings)
      throw new AppException({
        code: ConnectionErrorCodes.invalidConnectionConfig,
        msg: '当前没有可用的模型连接设置'
      })
    return this.createFromSettings(settings, request)
  }

  /**
   * 使用显式产品设置构造模型运行时，不从环境补足任何连接字段。
   * @param settings - 已保存的连接设置；只读取本次需要的字段。
   * @param request - 用户级超时和本次覆盖。
   * @throws {AppException} 密钥为空、扩展或执行参数不合法。
   */
  async createFromSettings(
    settings: ConnectionSettingsInfo,
    request: PiModelCreationRequest = {}
  ): Promise<PiModelRuntime> {
    const profile = assembleModelExecutionProfile({
      saved: {
        providerId: settings.providerId,
        baseUrl: settings.baseUrl,
        model: settings.model,
        contextWindow: settings.contextWindow,
        maxOutputTokens: settings.maxOutputTokens,
        temperature: settings.temperature,
        topP: settings.topP
      },
      user: request.user,
      override: request.override
    })
    if (settings.extension) validateProviderOptions(settings.providerId, settings.extension)
    if (!settings.apiKey.trim())
      throw new AppException({
        code: ConnectionErrorCodes.invalidApiKey,
        msg: 'API Key 不能为空'
      })

    const streamSimple = await this.loadStreamSimple(profile.providerId)
    const httpStatus = { last: undefined as number | undefined }
    const safeFetch = this.composeFetch(settings.extension, profile, httpStatus)
    const defaultHeaders = readStringRecord(settings.extension?.defaultHeaders)
    const model = createModel(profile, defaultHeaders)
    const streamFn = createStreamFn({
      streamSimple,
      providerId: profile.providerId,
      apiKey: settings.apiKey,
      profile,
      safeFetch,
      defaultHeaders
    })
    return { model, profile, streamFn, lastHttpStatus: () => httpStatus.last }
  }

  /**
   * 按供应商加载对应的 Pi API 适配器。模块是 ESM，只有真正创建运行时才加载。
   * @throws {Error} 模块缺失或无法加载。
   */
  private loadStreamSimple(
    providerId: ConnectionSettingsInfo['providerId']
  ): Promise<PiStreamSimple> {
    const cached = this.streams.get(providerId)
    if (cached) return cached
    const pending =
      providerId === 'anthropic'
        ? import('@earendil-works/pi-ai/api/anthropic-messages').then(
            (module) => module.streamSimple as PiStreamSimple
          )
        : import('@earendil-works/pi-ai/api/openai-completions').then(
            (module) => module.streamSimple as PiStreamSimple
          )
    this.streams.set(providerId, pending)
    return pending
  }

  /**
   * 组合请求边界：扩展查询与 fetch 选项先展开，随后强制禁止重定向和流空闲守卫。
   * 提供观察对象时记录最近一次非成功 HTTP 状态，供上层恢复鉴权等失败分类。
   * @param extension - 已通过供应商校验的扩展对象。
   * @param profile - 已校验的有效模型配置。
   * @param observed - 本次运行时共享的响应状态观察位；成功响应会清空旧失败状态。
   * @returns 每次请求都受保护的 fetch。
   */
  private composeFetch(
    extension: ConnectionSettingsInfo['extension'],
    profile: ModelExecutionProfile,
    observed?: { last?: number | undefined }
  ): typeof fetch {
    let fetcher = this.fetcher
    const defaultQuery = readStringRecord(extension?.defaultQuery)
    if (defaultQuery) fetcher = appendDefaultQuery(fetcher, defaultQuery)
    const fetchOptions = readPlainRecord(extension?.fetchOptions)
    if (fetchOptions) fetcher = mergeFetchOptions(fetcher, fetchOptions)
    if (profile.providerId === 'openai-compatible') {
      const configuredHeaders = readStringRecord(extension?.defaultHeaders)
      const preserved = new Set(
        Object.keys(configuredHeaders ?? {}).map((name) => name.toLowerCase())
      )
      fetcher = stripAmbientOpenAiHeaders(fetcher, preserved)
    }
    // 单次请求期限只约束到达响应头之前；正文空闲使用独立的固定上限。
    const guarded = guardStreamIdle(disallowRedirects(fetcher))
    if (!observed) return guarded
    return async (input, init) => {
      const response = await guarded(input, init)
      observed.last = response.ok ? undefined : response.status
      return response
    }
  }
}

/**
 * @param profile - 已校验的有效配置。
 * @param headers - 连接扩展里的默认请求头。
 * @returns 不含密钥的 Pi 模型描述。
 */
function createModel(
  profile: ModelExecutionProfile,
  headers: Readonly<Record<string, string>> | undefined
): Model<Api> {
  if (profile.providerId === 'anthropic') {
    const model: Model<'anthropic-messages'> = {
      id: profile.model,
      name: profile.model,
      api: 'anthropic-messages',
      provider: 'anthropic',
      baseUrl: profile.baseUrl,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: profile.contextWindow,
      maxTokens: profile.maxOutputTokens,
      reasoning: false,
      ...(headers ? { headers } : {})
    }
    return model
  }
  const model: Model<'openai-completions'> = {
    id: profile.model,
    name: profile.model,
    api: 'openai-completions',
    provider: 'openai',
    baseUrl: profile.baseUrl,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: profile.contextWindow,
    maxTokens: profile.maxOutputTokens,
    reasoning: false,
    // 旧链路始终发送 max_tokens；自定义兼容端点不一定接受 max_completion_tokens。
    compat: { maxTokensField: 'max_tokens' },
    ...(headers ? { headers } : {})
  }
  return model
}

interface StreamFnAssembly {
  streamSimple: PiStreamSimple
  providerId: ConnectionSettingsInfo['providerId']
  apiKey: string
  profile: ModelExecutionProfile
  safeFetch: typeof fetch
  defaultHeaders: Readonly<Record<string, string>> | undefined
}

/**
 * 把产品设置固定到每次 Pi 流请求上。调用方选项只补充，不能替换密钥、fetch、
 * 超时、重试次数和已保存的采样参数。
 */
function createStreamFn({
  streamSimple,
  providerId,
  apiKey,
  profile,
  safeFetch,
  defaultHeaders
}: StreamFnAssembly): StreamFn {
  const topP = profile.topP
  return (model, context, options) => {
    const samplingParams =
      providerId === 'openai-compatible' && topP !== undefined
        ? { top_p: topP, ...options?.samplingParams }
        : options?.samplingParams
    const onPayload =
      providerId === 'anthropic' && topP !== undefined
        ? composeTopPInjection(options?.onPayload, topP)
        : options?.onPayload
    return streamSimple(model, context, {
      ...options,
      apiKey,
      fetch: safeFetch,
      maxRetries: 0,
      ...(profile.requestTimeoutMs !== undefined ? { timeoutMs: profile.requestTimeoutMs } : {}),
      maxTokens: options?.maxTokens ?? profile.maxOutputTokens,
      ...(profile.temperature !== undefined ? { temperature: profile.temperature } : {}),
      ...(samplingParams !== undefined ? { samplingParams } : {}),
      ...(onPayload !== undefined ? { onPayload } : {}),
      ...(defaultHeaders ? { headers: mergeHeaders(defaultHeaders, options?.headers) } : {})
    })
  }
}

/**
 * 把 top-p 合并进 Anthropic 请求体。Pi 的 Anthropic 选项没有独立 topP 字段。
 * @param existing - 调用方已有的请求体观察或替换回调。
 * @param topP - 已保存的 top-p。
 */
function composeTopPInjection(
  existing: SimpleStreamOptions['onPayload'],
  topP: number
): SimpleStreamOptions['onPayload'] {
  return async (payload, model) => {
    const replaced = existing ? await existing(payload, model) : undefined
    const base = replaced === undefined ? payload : replaced
    if (base === null || typeof base !== 'object' || Array.isArray(base)) return replaced
    return { ...(base as Record<string, unknown>), top_p: topP }
  }
}

/**
 * OpenAI SDK 会从进程环境补入组织与项目请求头；产品只用已保存设置，不能把它们带给用户端点。
 * 扩展显式声明的同名头保留。
 */
function stripAmbientOpenAiHeaders(
  fetcher: typeof fetch,
  preserved: ReadonlySet<string>
): typeof fetch {
  const names = ['openai-organization', 'openai-project'].filter((name) => !preserved.has(name))
  if (names.length === 0) return fetcher
  return (input, init) => {
    if (!init?.headers) return fetcher(input, init)
    const headers = new Headers(init.headers)
    for (const name of names) headers.delete(name)
    return fetcher(input, { ...init, headers })
  }
}

/** 上游重定向会把凭据带到另一个地址，统一禁止跟随。 */
function disallowRedirects(fetcher: typeof fetch): typeof fetch {
  return (input, init) => fetcher(input, { ...init, redirect: 'error' })
}

/**
 * 把已校验的扩展查询参数补到请求地址；调用方已有的同名参数优先。
 */
function appendDefaultQuery(
  fetcher: typeof fetch,
  query: Readonly<Record<string, string>>
): typeof fetch {
  const entries = Object.entries(query)
  if (entries.length === 0) return fetcher
  return (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    for (const [key, value] of entries) {
      if (!url.searchParams.has(key)) url.searchParams.set(key, value)
    }
    return fetcher(url, init)
  }
}

/**
 * 扩展 fetch 选项作为底层默认值；本次请求初始化里的同名字段优先，
 * 随后的禁重定向仍会覆盖 `redirect`。
 */
function mergeFetchOptions(
  fetcher: typeof fetch,
  options: Readonly<Record<string, unknown>>
): typeof fetch {
  return (input, init) => fetcher(input, { ...options, ...init } as RequestInit)
}

/** 合并默认请求头和本次请求头；名称大小写不敏感，本次请求优先。 */
function mergeHeaders(
  defaults: Readonly<Record<string, string>>,
  overrides: Readonly<Record<string, string | null>> | undefined
): Record<string, string | null> {
  const merged: Record<string, string | null> = { ...defaults }
  for (const [name, value] of Object.entries(overrides ?? {})) {
    for (const existing of Object.keys(merged)) {
      if (existing.toLowerCase() === name.toLowerCase()) delete merged[existing]
    }
    merged[name] = value
  }
  return merged
}

/** 已通过扩展校验，读取为字符串记录；缺省时返回 undefined。 */
function readStringRecord(value: unknown): Record<string, string> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, string>
}

/** 已通过扩展校验，读取为普通对象；缺省时返回 undefined。 */
function readPlainRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}
