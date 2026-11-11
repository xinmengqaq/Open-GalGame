import { ChatAnthropic } from '@langchain/anthropic'
import { ChatOpenAI } from '@langchain/openai'

import { mergeProviderClientOptions } from '@infrastructure/connections/mergeProviderClientOptions'
import { validateProviderOptions } from '@infrastructure/connections/validateProviderOptions'
import {
  assembleModelExecutionProfile,
  type ModelExecutionOverride,
  type ModelExecutionProfile,
  type ModelUserExecutionPreference
} from '../config/modelExecutionConfig'
import { AppException } from '@common/errors/AppException'
import { ConnectionErrorCodes } from '@domain/connections/errors/ConnectionErrorCodes'
import type { ConnectionSettingsInfo } from '@domain/connections/models/ConnectionSettings'
import { guardStreamIdle } from './streamIdleGuard'

/** 创建模型时可选的用户级参数和本次覆盖。 */
export interface ChatModelCreationRequest {
  user?: ModelUserExecutionPreference
  override?: ModelExecutionOverride
}

/** 原生聊天模型及不含密钥的有效配置。 */
export interface ChatModelCreation {
  model: ChatOpenAI | ChatAnthropic
  profile: ModelExecutionProfile
}

/**
 * 上游重定向会把凭据带到另一个地址，统一禁止跟随。
 * @param fetcher - 调用方注入或全局 fetch。
 */
function disallowRedirects(fetcher: typeof fetch): typeof fetch {
  return (input, init) => fetcher(input, { ...init, redirect: 'error' })
}

/** 只取出采样字段。未配置时不传，避免 SDK 收到空值后再补默认采样。 */
function samplingFields(
  profile: ModelExecutionProfile
): { temperature: number } | { topP: number } | Record<string, never> {
  if (profile.temperature !== undefined) return { temperature: profile.temperature }
  if (profile.topP !== undefined) return { topP: profile.topP }
  return {}
}

/**
 * 按已保存连接设置构造可直接调用的 LangChain 聊天模型。
 * 凭据只在创建模型时读取，不写入配置对象。
 */
export class LangChainModelFactory {
  /**
   * @param loadSettings - 读取已保存的完整连接设置。没有可用设置时返回 null。
   * @param fetcher - 可选 fetch。测试注入替身；默认使用全局 fetch。
   */
  constructor(
    private readonly loadSettings: () => Promise<ConnectionSettingsInfo | null>,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  /**
   * 读取已保存设置并构造聊天模型。构造过程不访问网络。
   * @param request - 用户级超时和本次覆盖。省略时沿用已保存参数和建议默认超时。
   * @returns 原生 LangChain 模型，以及不含密钥的有效配置。
   * @throws {AppException} 没有可用设置、密钥为空或执行参数不合法。存储抛出的异常原样继续抛出。
   */
  async createModel(request?: ChatModelCreationRequest): Promise<ChatModelCreation> {
    const settings = await this.loadSettings()
    if (!settings)
      throw new AppException({
        code: ConnectionErrorCodes.invalidConnectionConfig,
        msg: '当前没有可用的模型连接设置'
      })
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
      user: request?.user,
      override: request?.override
    })
    if (settings.extension) validateProviderOptions(settings.providerId, settings.extension)
    if (!settings.apiKey.trim())
      throw new AppException({
        code: ConnectionErrorCodes.invalidApiKey,
        msg: 'API Key 不能为空'
      })
    return { model: this.createChatModel(settings.apiKey, profile, settings.extension), profile }
  }

  /**
   * @param apiKey - 本次创建使用的用户密钥，不进入返回的配置。
   * @param profile - 已校验的无密钥配置。
   * @param extension - 已校验的扩展对象。缺省时不改变现有请求。
   */
  private createChatModel(
    apiKey: string,
    profile: ModelExecutionProfile,
    extension?: ConnectionSettingsInfo['extension']
  ): ChatOpenAI | ChatAnthropic {
    // 整体期限可能被调用方显式关闭；流式正文仍要有空闲上限，避免头到后正文停发永远不结束。
    const safeFetch = guardStreamIdle(disallowRedirects(this.fetcher), profile.requestTimeoutMs)
    const sampling = samplingFields(profile)
    const clientOptions = mergeProviderClientOptions(
      extension,
      {
        baseURL: profile.baseUrl,
        apiKey,
        fetch: safeFetch,
        maxRetries: 0
      },
      profile.requestTimeoutMs
    )
    if (profile.providerId === 'anthropic')
      return new ChatAnthropic({
        model: profile.model,
        apiKey,
        anthropicApiUrl: profile.baseUrl,
        maxTokens: profile.maxOutputTokens,
        ...sampling,
        maxRetries: 0,
        clientOptions
      })
    return new ChatOpenAI({
      model: profile.model,
      apiKey,
      maxTokens: profile.maxOutputTokens,
      ...sampling,
      maxRetries: 0,
      ...(profile.requestTimeoutMs !== undefined ? { timeout: profile.requestTimeoutMs } : {}),
      configuration: { ...clientOptions, organization: null, project: null }
    })
  }
}
