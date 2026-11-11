import { ChatAnthropic } from '@langchain/anthropic'
import { ChatOpenAI } from '@langchain/openai'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { mergeProviderClientOptions } from '@infrastructure/connections/mergeProviderClientOptions'
import { AttemptTimedOut } from '@infrastructure/ai/execution/executionErrors'
import { normalizeAgentError } from '@infrastructure/ai/middleware/retryPolicy'
import { LangChainModelFactory } from '@infrastructure/ai/models/LangChainModelFactory'
import { classifyRunError } from '@infrastructure/scene-generation/workflow/runFailureRouting'
import { AppException } from '@common/errors/AppException'
import { ConnectionErrorCodes } from '@domain/connections/errors/ConnectionErrorCodes'
import type { ConnectionSettingsInfo } from '@domain/connections/models/ConnectionSettings'

const saved: ConnectionSettingsInfo = {
  providerId: 'openai-compatible',
  baseUrl: 'https://service.example/v1',
  model: 'chosen',
  contextWindow: 200000,
  maxOutputTokens: 32000,
  apiKey: 'stored-secret'
}

const openAiCompletion = {
  id: 'chatcmpl-test',
  object: 'chat.completion',
  created: 1,
  model: 'chosen',
  choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }]
}

const anthropicMessage = {
  id: 'msg-test',
  type: 'message',
  role: 'assistant',
  model: 'claude-test',
  content: [{ type: 'text', text: 'OK' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 4, output_tokens: 1 }
}

function stubAmbientCredentials(): void {
  vi.stubEnv('OPENAI_API_KEY', 'ambient-openai-key')
  vi.stubEnv('OPENAI_ORG_ID', 'ambient-org')
  vi.stubEnv('OPENAI_ORGANIZATION', 'ambient-organization')
  vi.stubEnv('OPENAI_PROJECT_ID', 'ambient-project')
  vi.stubEnv('OPENAI_BASE_URL', 'https://ambient.example/v1')
  vi.stubEnv('ANTHROPIC_API_KEY', 'ambient-anthropic-key')
  vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'ambient-anthropic-token')
  vi.stubEnv('ANTHROPIC_BASE_URL', 'https://ambient-anthropic.example')
  vi.stubEnv('LANGSMITH_API_KEY', 'ambient-langsmith-key')
}

function requestBody(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>
}

function headerText(init: RequestInit | undefined): string {
  return JSON.stringify([...new Headers(init?.headers)])
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('LangChain 聊天模型构造', () => {
  it('构造工厂和创建模型都不访问网络，调用时才发送已保存的输出上限', async () => {
    stubAmbientCredentials()
    const fetcher = vi.fn(async () => Response.json(openAiCompletion))
    const loadSettings = vi.fn(async () => saved)
    const factory = new LangChainModelFactory(loadSettings, fetcher)

    expect(loadSettings).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
    const created = await factory.createModel()
    expect(loadSettings).toHaveBeenCalledTimes(1)
    expect(fetcher).not.toHaveBeenCalled()
    expect(created.model).toBeInstanceOf(ChatOpenAI)
    expect(created.profile).toEqual({
      providerId: 'openai-compatible',
      baseUrl: saved.baseUrl,
      model: 'chosen',
      contextWindow: 200000,
      maxOutputTokens: 32000,
      requestTimeoutMs: 240000
    })
    expect(JSON.stringify(created.profile)).not.toContain('stored-secret')

    await created.model.invoke('ping')
    expect(fetcher).toHaveBeenCalledTimes(1)
    const init = fetcher.mock.calls[0]?.[1]
    expect(String(fetcher.mock.calls[0]?.[0])).toBe('https://service.example/v1/chat/completions')
    expect(requestBody(init)).toMatchObject({ model: 'chosen', max_tokens: 32000 })
    expect(requestBody(init)).not.toHaveProperty('temperature')
    expect(requestBody(init)).not.toHaveProperty('top_p')
    expect(init?.redirect).toBe('error')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer stored-secret')
    expect(new Headers(init?.headers).get('openai-organization')).toBeNull()
    expect(new Headers(init?.headers).get('openai-project')).toBeNull()
    expect(headerText(init)).not.toContain('ambient')
  })

  it('Anthropic 使用消息接口、配置的输出上限，且不夹带环境令牌', async () => {
    stubAmbientCredentials()
    const fetcher = vi.fn(async () => Response.json(anthropicMessage))
    const factory = new LangChainModelFactory(
      async () => ({
        ...saved,
        providerId: 'anthropic',
        baseUrl: 'https://anthropic.example',
        model: 'claude-test',
        temperature: 0
      }),
      fetcher
    )
    const created = await factory.createModel({ user: { requestTimeoutMs: 180000 } })

    expect(created.model).toBeInstanceOf(ChatAnthropic)
    expect(created.profile).toMatchObject({
      providerId: 'anthropic',
      baseUrl: 'https://anthropic.example',
      model: 'claude-test',
      maxOutputTokens: 32000,
      requestTimeoutMs: 180000,
      temperature: 0
    })
    expect(created.profile).not.toHaveProperty('topP')
    await created.model.invoke('ping')
    const init = fetcher.mock.calls[0]?.[1]
    expect(String(fetcher.mock.calls[0]?.[0])).toBe('https://anthropic.example/v1/messages')
    expect(requestBody(init)).toMatchObject({
      model: 'claude-test',
      max_tokens: 32000,
      temperature: 0
    })
    expect(requestBody(init)).not.toHaveProperty('top_p')
    expect(init?.redirect).toBe('error')
    const headers = new Headers(init?.headers)
    expect(headers.get('x-api-key')).toBe('stored-secret')
    expect(headers.get('authorization')).toBeNull()
    expect(headers.get('x-stainless-timeout')).toBe('180')
    expect(headerText(init)).not.toContain('ambient')
  })

  it('已保存的 top-p 进入请求，本次合法覆盖优先', async () => {
    const fetcher = vi.fn(async () => Response.json(openAiCompletion))
    const factory = new LangChainModelFactory(async () => ({ ...saved, topP: 0.9 }), fetcher)
    const created = await factory.createModel({
      user: { requestTimeoutMs: 180000 },
      override: { maxOutputTokens: 16000, requestTimeoutMs: 60000 }
    })

    await created.model.invoke('ping')
    const init = fetcher.mock.calls[0]?.[1]
    expect(requestBody(init)).toMatchObject({ max_tokens: 16000, top_p: 0.9 })
    expect(requestBody(init)).not.toHaveProperty('temperature')
    expect(created.profile.requestTimeoutMs).toBe(60000)
  })

  it('非法覆盖和采样冲突在发起请求前失败', async () => {
    const fetcher = vi.fn(async () => Response.json(openAiCompletion))
    const factory = new LangChainModelFactory(async () => ({ ...saved, temperature: 0.4 }), fetcher)

    await expect(factory.createModel({ override: { requestTimeoutMs: 0 } })).rejects.toMatchObject({
      code: 1401,
      message: '单次请求超时必须为正整数'
    })
    await expect(factory.createModel({ override: { topP: 0.2 } })).rejects.toMatchObject({
      code: 1401,
      message: '温度与 top-p 只能填写一个'
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('已保存扩展含不会生效的键时，建模型前拒绝且不发请求', async () => {
    const secret = 'session-secret-value'
    const fetcher = vi.fn(async () => Response.json(openAiCompletion))
    const factory = new LangChainModelFactory(
      async () => ({ ...saved, extension: { timeout: secret } }),
      fetcher
    )

    await expect(factory.createModel()).rejects.toMatchObject({
      code: 1401,
      message: expect.stringContaining('timeout')
    })
    await expect(factory.createModel()).rejects.not.toMatchObject({
      message: expect.stringContaining(secret)
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each(['openai-compatible', 'anthropic'] as const)(
    '%s 扩展进入真实请求，应用控制项不被改写',
    async (providerId) => {
      const session = 'fake-session'
      const stolenKey = 'stolen-key'
      const extensionFetch = vi.fn(async () => new Response('extension-fetch'))
      const fetcher = vi.fn(async () =>
        Response.json(providerId === 'anthropic' ? anthropicMessage : openAiCompletion)
      )
      const baseUrl =
        providerId === 'anthropic' ? 'https://anthropic.example' : 'https://service.example/v1'
      const extension = {
        defaultHeaders: { 'x-opencode-session': session, 'User-Agent': 'custom-agent' },
        defaultQuery: { trace: 'request-marker' },
        fetchOptions: { cache: 'no-store', referrer: 'extension-referrer' },
        logLevel: 'off',
        baseURL: 'https://override.example/v1',
        apiKey: stolenKey,
        authToken: 'stolen-token',
        timeout: 1,
        maxRetries: 4,
        fetch: extensionFetch
      }
      const merged = mergeProviderClientOptions(
        extension,
        {
          baseURL: baseUrl,
          apiKey: 'stored-secret',
          fetch: fetcher,
          maxRetries: 0
        },
        1000
      )
      expect(merged).toMatchObject({
        baseURL: baseUrl,
        apiKey: 'stored-secret',
        fetch: fetcher,
        timeout: 1000,
        maxRetries: 0,
        authToken: null,
        defaultHeaders: extension.defaultHeaders,
        defaultQuery: extension.defaultQuery,
        fetchOptions: extension.fetchOptions,
        logLevel: 'off'
      })
      expect(JSON.stringify(merged)).not.toContain(stolenKey)

      const factory = new LangChainModelFactory(
        async () => ({
          ...saved,
          providerId,
          baseUrl,
          model: providerId === 'anthropic' ? 'claude-test' : saved.model,
          extension: {
            defaultHeaders: extension.defaultHeaders,
            defaultQuery: extension.defaultQuery,
            fetchOptions: extension.fetchOptions,
            logLevel: extension.logLevel
          }
        }),
        fetcher
      )
      const { model } = await factory.createModel({ override: { requestTimeoutMs: 1000 } })
      await model.invoke('ping')

      const [url, init] = fetcher.mock.calls[0] ?? []
      const address = new URL(String(url))
      expect(address.origin + address.pathname).toBe(
        providerId === 'anthropic'
          ? 'https://anthropic.example/v1/messages'
          : 'https://service.example/v1/chat/completions'
      )
      expect(address.searchParams.get('trace')).toBe('request-marker')
      const headers = new Headers(init?.headers)
      expect(headers.get('x-opencode-session')).toBe(session)
      if (providerId === 'openai-compatible') {
        expect(headers.get('user-agent')).toMatch(/^langchainjs-openai\//)
      } else {
        expect(headers.get('user-agent')).toBe('custom-agent')
      }
      expect(headers.get('x-stainless-timeout')).toBe('1')
      expect(init?.cache).toBe('no-store')
      expect(init?.referrer).toBe('extension-referrer')
      expect(init?.redirect).toBe('error')
      if (providerId === 'anthropic') expect(headers.get('x-api-key')).toBe('stored-secret')
      else expect(headers.get('authorization')).toBe('Bearer stored-secret')
      expect(headerText(init)).not.toContain(stolenKey)
      expect(extensionFetch).not.toHaveBeenCalled()
    }
  )

  it('空扩展与缺省扩展发出同一类请求', async () => {
    const emptyFetch = vi.fn(async () => Response.json(openAiCompletion))
    const absentFetch = vi.fn(async () => Response.json(openAiCompletion))
    const empty = await new LangChainModelFactory(
      async () => ({ ...saved, extension: {} }),
      emptyFetch
    ).createModel()
    const absent = await new LangChainModelFactory(async () => saved, absentFetch).createModel()

    await empty.model.invoke('ping')
    await absent.model.invoke('ping')
    expect(String(emptyFetch.mock.calls[0]?.[0])).toBe(String(absentFetch.mock.calls[0]?.[0]))
    expect(new Headers(emptyFetch.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(
      'Bearer stored-secret'
    )
    expect(emptyFetch.mock.calls[0]?.[1]?.redirect).toBe('error')
  })

  it('没有可用设置或密钥时不回退环境变量', async () => {
    stubAmbientCredentials()
    const fetcher = vi.fn(async () => Response.json(openAiCompletion))
    const missing = new LangChainModelFactory(async () => null, fetcher)
    const blankKey = new LangChainModelFactory(async () => ({ ...saved, apiKey: ' ' }), fetcher)

    await expect(missing.createModel()).rejects.toMatchObject({
      code: ConnectionErrorCodes.invalidConnectionConfig,
      message: '当前没有可用的模型连接设置'
    })
    await expect(blankKey.createModel()).rejects.toMatchObject({
      code: ConnectionErrorCodes.invalidApiKey,
      message: 'API Key 不能为空'
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('存储失败原样抛出', async () => {
    const cause = new Error('disk')
    const stored = new AppException({
      code: ConnectionErrorCodes.credentialStoreFailed,
      msg: '连接设置读取失败',
      cause
    })
    const technical = new Error('unmapped')
    const factory = new LangChainModelFactory(async () => {
      throw stored
    }, vi.fn())
    const raw = new LangChainModelFactory(async () => {
      throw technical
    }, vi.fn())

    await expect(factory.createModel()).rejects.toBe(stored)
    await expect(raw.createModel()).rejects.toBe(technical)
    expect(stored.cause).toBe(cause)
  })

  it.each(['openai-compatible', 'anthropic'] as const)(
    '%s 上游失败只请求一次',
    async (providerId) => {
      const fetcher = vi.fn(async () => new Response('no', { status: 500 }))
      const factory = new LangChainModelFactory(
        async () =>
          providerId === 'anthropic'
            ? { ...saved, providerId, baseUrl: 'https://anthropic.example', model: 'claude-test' }
            : saved,
        fetcher
      )
      const { model } = await factory.createModel()

      await expect(model.invoke('ping')).rejects.toThrow()
      expect(fetcher).toHaveBeenCalledTimes(1)
    }
  )

  it('调用方取消信号会中止已经发出的请求', async () => {
    const controller = new AbortController()
    let markStarted: () => void = () => undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      markStarted()
      return new Promise<Response>((_resolve, reject) => {
        const fail = (): void => reject(new DOMException('aborted', 'AbortError'))
        if (init?.signal?.aborted) fail()
        else init?.signal?.addEventListener('abort', fail, { once: true })
      })
    })
    const factory = new LangChainModelFactory(async () => saved, fetcher)
    const { model } = await factory.createModel()
    const pending = model.invoke('ping', { signal: controller.signal })

    await started
    controller.abort()
    await expect(pending).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('未指定超时的 Anthropic 请求使用建议默认超时', async () => {
    const fetcher = vi.fn(async () => Response.json(anthropicMessage))
    const factory = new LangChainModelFactory(
      async () => ({
        ...saved,
        providerId: 'anthropic',
        baseUrl: 'https://anthropic.example',
        model: 'claude-test'
      }),
      fetcher
    )
    const { model } = await factory.createModel()

    await model.invoke('ping')
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get('x-stainless-timeout')).toBe('240')
  })

  it('显式省略超时不向 SDK 写入超时，也不安装默认计时器', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn(async () => Response.json(openAiCompletion))
    const factory = new LangChainModelFactory(async () => saved, fetcher)
    const created = await factory.createModel({ override: { requestTimeoutMs: undefined } })

    expect(created.profile).not.toHaveProperty('requestTimeoutMs')
    const pending = created.model.invoke('ping')
    await vi.advanceTimersByTimeAsync(2_147_483_647)
    await expect(pending).resolves.toBeDefined()
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).has('x-stainless-timeout')).toBe(false)
  })

  it('配置的短超时到点才中止挂起请求', async () => {
    vi.useFakeTimers()
    let markStarted: () => void = () => undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      markStarted()
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          { once: true }
        )
      })
    })
    const factory = new LangChainModelFactory(async () => saved, fetcher)
    const { model } = await factory.createModel({ override: { requestTimeoutMs: 1000 } })
    const outcome = model.invoke('ping').then(
      () => 'resolved' as const,
      () => 'rejected' as const
    )

    await started
    await vi.advanceTimersByTimeAsync(999)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(await Promise.race([outcome, Promise.resolve('pending' as const)])).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    await expect(outcome).resolves.toBe('rejected')
  })

  it('模型流式正文停发时由空闲守卫按模型瞬时失败结束', async () => {
    vi.useFakeTimers()
    let requestSignal: AbortSignal | null | undefined
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal
      return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
        headers: { 'content-type': 'text/event-stream' }
      })
    })
    const factory = new LangChainModelFactory(async () => saved, fetcher)
    const { model } = await factory.createModel({ override: { requestTimeoutMs: 50 } })
    const outcome = (async () => {
      const stream = await model.stream('ping')
      for await (const _chunk of stream) void _chunk
    })().then(
      () => undefined,
      (error: unknown) => error
    )

    await vi.advanceTimersByTimeAsync(0)
    expect(fetcher).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(50)

    const error = await outcome
    expect(error).toBeInstanceOf(AttemptTimedOut)
    expect(classifyRunError(error, undefined)).toMatchObject({
      failureClass: 'modelTransient',
      retryable: true
    })
    // 生产路径会先把模型调用错误收成 AppException 再分类；归一化后仍须是模型瞬时失败。
    const normalized = normalizeAgentError(error)
    expect(normalized).toBeInstanceOf(AppException)
    expect(normalized.cause).toBeInstanceOf(AttemptTimedOut)
    expect(classifyRunError(normalized, undefined)).toMatchObject({
      failureClass: 'modelTransient',
      retryable: true
    })
    expect(requestSignal?.aborted).toBe(true)
  })
})
