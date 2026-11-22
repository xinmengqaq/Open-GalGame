import { Anthropic } from '@anthropic-ai/sdk'
import { ChatAnthropic } from '@langchain/anthropic'
import { ChatOpenAI } from '@langchain/openai'
import { OpenAI } from 'openai'

import { mergeProviderClientOptions } from './mergeProviderClientOptions'
import { validateProviderOptions as validateProviderExtension } from './validateProviderOptions'
import type { ModelConnectionGateway } from '@application/connections/ports/ModelConnectionGateway'
import type {
  ConnectionTestVO,
  ModelListVO
} from '@application/connections/vo/ConnectionSettingsVO'
import { AppException } from '@common/errors/AppException'
import { ConnectionErrorCodes } from '@domain/connections/errors/ConnectionErrorCodes'
import type {
  ConnectionAccess,
  ConnectionExtension,
  ConnectionSettingsInfo
} from '@domain/connections/models/ConnectionSettings'

function disallowRedirects(fetcher: typeof fetch): typeof fetch {
  return (input, init) => fetcher(input, { ...init, redirect: 'error' })
}

function upstreamStatus(error: unknown): unknown {
  if (error === null || typeof error !== 'object' || !Object.hasOwn(error, 'status'))
    return undefined
  return (error as { status: unknown }).status
}

export class LangChainModelConnectionGatewayImpl implements ModelConnectionGateway {
  constructor(
    private readonly timeoutMs: number,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  validateProviderOptions(
    providerId: ConnectionAccess['providerId'],
    extension: ConnectionExtension
  ): void {
    validateProviderExtension(providerId, extension)
  }

  async testConnection(settings: ConnectionSettingsInfo): Promise<ConnectionTestVO> {
    const safeFetch = disallowRedirects(this.fetcher)
    if (settings.extension) this.validateProviderOptions(settings.providerId, settings.extension)
    const clientOptions = mergeProviderClientOptions(
      settings.extension,
      {
        baseURL: settings.baseUrl,
        apiKey: settings.apiKey,
        fetch: safeFetch,
        maxRetries: 0
      },
      this.timeoutMs
    )
    try {
      const model =
        settings.providerId === 'anthropic'
          ? new ChatAnthropic({
              model: settings.model,
              apiKey: settings.apiKey,
              anthropicApiUrl: settings.baseUrl,
              maxTokens: 1,
              temperature: settings.temperature,
              topP: settings.topP,
              maxRetries: 0,
              clientOptions
            })
          : new ChatOpenAI({
              model: settings.model,
              apiKey: settings.apiKey,
              maxTokens: 1,
              temperature: settings.temperature,
              topP: settings.topP,
              maxRetries: 0,
              timeout: this.timeoutMs,
              configuration: { ...clientOptions, organization: null, project: null }
            })
      await model.invoke('Reply OK.', { signal: AbortSignal.timeout(this.timeoutMs) })
      return { available: true }
    } catch (error) {
      this.throwUpstreamFailure(error, '连接测试超时')
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
      this.throwUpstreamFailure(error, '拉取模型列表超时')
    }
  }

  private throwUpstreamFailure(error: unknown, timeoutMsg: string): never {
    if (error instanceof AppException) throw error
    const status = upstreamStatus(error)
    if (status === 401 || status === 403)
      throw new AppException({
        code: ConnectionErrorCodes.invalidApiKey,
        msg: 'API Key 无效或无访问权限',
        cause: error
      })
    if (status === 404)
      throw new AppException({
        code: ConnectionErrorCodes.modelUnavailable,
        msg: '指定模型或接口不可用',
        cause: error
      })
    if (status === 429)
      throw new AppException({
        code: ConnectionErrorCodes.rateLimited,
        msg: '模型服务请求频率受限',
        cause: error
      })
    if (typeof status === 'number' || error instanceof SyntaxError)
      throw new AppException({
        code: ConnectionErrorCodes.modelServiceError,
        msg: '模型服务未返回有效结果',
        cause: error
      })
    if (error instanceof Error && /Abort|Timeout/i.test(error.name))
      throw new AppException({
        code: ConnectionErrorCodes.connectionTimeout,
        msg: timeoutMsg,
        cause: error
      })
    throw new AppException({
      code: ConnectionErrorCodes.cannotReachModel,
      msg: '无法连接模型服务，请检查地址与网络',
      cause: error
    })
  }
}
