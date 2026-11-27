import { Anthropic } from '@anthropic-ai/sdk'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { OpenAI } from 'openai'

import { validateProviderOptions } from '@infrastructure/connections/validateProviderOptions'
import { mergeProviderClientOptions } from '@infrastructure/connections/mergeProviderClientOptions'
import type { ModelConnectionGateway } from '@application/settings/connections/ports/ModelConnectionGateway'
import type {
  ConnectionTestVO,
  ModelListVO
} from '@application/settings/connections/vo/ConnectionSettingsVO'
import { AppException } from '@common/errors/AppException'
import { ConnectionErrorCodes } from '@domain/settings/connections/errors/ConnectionErrorCodes'
import type {
  ConnectionAccess,
  ConnectionExtension,
  ConnectionSettingsInfo
} from '@domain/settings/connections/models/ConnectionSettings'

import type { PiModelFactory } from './PiModelFactory'

const TEST_PROMPT = 'Reply with OK.'

function disallowRedirects(fetcher: typeof fetch): typeof fetch {
  return (input, init) => fetcher(input, { ...init, redirect: 'error' })
}

function upstreamStatus(error: unknown): unknown {
  if (error === null || typeof error !== 'object' || !('status' in error)) return undefined
  return error.status
}

function isTimeoutSignal(signal: AbortSignal): boolean {
  if (!signal.aborted) return false
  const reason: unknown = signal.reason
  return (
    typeof reason === 'object' &&
    reason !== null &&
    'name' in reason &&
    reason.name === 'TimeoutError'
  )
}

const PROVIDER_FINISH_REASON_PREFIX = 'Provider finish_reason: '

function providerFailureReason(errorMessage: string | undefined): string {
  if (errorMessage === `${PROVIDER_FINISH_REASON_PREFIX}content_filter`)
    return 'providerFinishReasonContentFilter'
  if (errorMessage === `${PROVIDER_FINISH_REASON_PREFIX}network_error`)
    return 'providerFinishReasonNetworkError'
  if (errorMessage?.startsWith(PROVIDER_FINISH_REASON_PREFIX)) return 'providerFinishReason'
  if (
    errorMessage === 'Stream ended without finish_reason' ||
    errorMessage === 'Anthropic stream ended without a stop reason'
  )
    return 'streamWithoutFinishReason'
  if (errorMessage === 'The model refused to complete the request') return 'providerRefusal'
  if (errorMessage === 'Provider stopped with: sensitive') return 'providerContentFlagged'
  if (errorMessage?.startsWith('Unhandled stop reason: ')) return 'providerUnknownStopReason'
  return 'providerError'
}

/**
 * 用于连接设置的产品适配：测试走生成实际使用的 Pi 运行时，
 * 模型列表沿用供应商 SDK 的目录接口。
 */
export class PiModelConnectionGatewayImpl implements ModelConnectionGateway {
  constructor(
    private readonly models: PiModelFactory,
    private readonly timeoutMs: number,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  validateProviderOptions(
    providerId: ConnectionAccess['providerId'],
    extension: ConnectionExtension
  ): void {
    validateProviderOptions(providerId, extension)
  }

  async testConnection(settings: ConnectionSettingsInfo): Promise<ConnectionTestVO> {
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const runtime = await this.models.createFromSettings(settings, {
      override: { requestTimeoutMs: this.timeoutMs, maxOutputTokens: 1 }
    })
    try {
      // pi-ai 是 ESM-only 包，CJS 主进程不能用 require 静态加载它。
      const { normalizeContext } = await import('@earendil-works/pi-ai')
      const stream = await runtime.streamFn(
        runtime.model,
        normalizeContext({
          messages: [{ role: 'user', content: TEST_PROMPT, timestamp: Date.now() }]
        }),
        { signal: timeout }
      )
      const message = await stream.result()
      if (message.stopReason === 'error' || message.stopReason === 'aborted') {
        this.throwUpstreamFailure(undefined, runtime.lastHttpStatus?.(), timeout, message)
      }
      return { available: true }
    } catch (error) {
      this.throwUpstreamFailure(error, runtime.lastHttpStatus?.(), timeout)
    }
  }

  async listModels(access: ConnectionAccess): Promise<ModelListVO> {
    const safeFetch = disallowRedirects(this.fetcher)
    if (access.extension) this.validateProviderOptions(access.providerId, access.extension)
    const clientOptions = mergeProviderClientOptions(
      access.extension,
      {
        baseURL: access.baseUrl,
        apiKey: access.apiKey,
        fetch: safeFetch,
        maxRetries: 0
      },
      this.timeoutMs
    )
    try {
      const page =
        access.providerId === 'anthropic'
          ? await new Anthropic(clientOptions).models.list()
          : await new OpenAI({ ...clientOptions, organization: null, project: null }).models.list()
      const models = [...new Set(page.data.map((model) => model.id.trim()).filter(Boolean))]
      if (models.length === 0)
        throw new AppException({
          code: ConnectionErrorCodes.modelServiceError,
          msg: '模型服务未返回可用模型列表'
        })
      return { models }
    } catch (error) {
      this.throwUpstreamFailure(error, undefined, undefined, undefined, '拉取模型列表超时')
    }
  }

  private throwUpstreamFailure(
    error: unknown,
    status: number | undefined,
    timeout: AbortSignal | undefined,
    message?: AssistantMessage,
    timeoutMsg = '连接测试超时'
  ): never {
    if (error instanceof AppException) throw error
    const code = status ?? upstreamStatus(error)
    const failureReason =
      typeof code === 'number'
        ? `providerHttpStatus${code}`
        : error instanceof SyntaxError
          ? 'invalidProviderResponse'
          : message?.stopReason === 'error'
            ? providerFailureReason(message.errorMessage)
            : undefined
    const failureCause =
      error ?? (failureReason === undefined ? undefined : new Error(failureReason))
    if (code === 401 || code === 403)
      throw new AppException({
        code: ConnectionErrorCodes.invalidApiKey,
        msg: 'API Key 无效或无访问权限',
        cause: failureCause
      })
    if (code === 404)
      throw new AppException({
        code: ConnectionErrorCodes.modelUnavailable,
        msg: '指定模型或接口不可用',
        cause: failureCause
      })
    if (code === 429)
      throw new AppException({
        code: ConnectionErrorCodes.rateLimited,
        msg: '模型服务请求频率受限',
        cause: failureCause
      })
    if (typeof code === 'number' || error instanceof SyntaxError)
      throw new AppException({
        code: ConnectionErrorCodes.modelServiceError,
        msg: '模型服务未返回有效结果',
        reason: failureReason ?? 'providerError',
        cause: failureCause
      })
    if (timeout !== undefined && isTimeoutSignal(timeout))
      throw new AppException({
        code: ConnectionErrorCodes.connectionTimeout,
        msg: timeoutMsg,
        cause: error
      })
    if (error instanceof Error && /Abort|Timeout/i.test(error.name))
      throw new AppException({
        code: ConnectionErrorCodes.connectionTimeout,
        msg: timeoutMsg,
        cause: error
      })
    if (message?.stopReason === 'error')
      throw new AppException({
        code: ConnectionErrorCodes.modelServiceError,
        msg: '模型服务未返回有效结果',
        reason: failureReason ?? providerFailureReason(message.errorMessage),
        cause: failureCause
      })
    throw new AppException({
      code: ConnectionErrorCodes.cannotReachModel,
      msg: '无法连接模型服务，请检查地址与网络',
      cause: error
    })
  }
}
