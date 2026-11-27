import { afterEach, describe, expect, it, vi } from 'vitest'

import { normalizeContext } from '@earendil-works/pi-ai'

import { PiModelFactory } from '@infrastructure/ai/pi/PiModelFactory'
import { ConnectionErrorCodes } from '@domain/settings/connections/errors/ConnectionErrorCodes'
import type { ConnectionSettingsInfo } from '@domain/settings/connections/models/ConnectionSettings'

const saved: ConnectionSettingsInfo = {
  providerId: 'openai-compatible',
  baseUrl: 'https://service.example/v1',
  model: 'chosen',
  contextWindow: 200000,
  maxOutputTokens: 32000,
  apiKey: 'stored-secret'
}

const openAiStream = [
  'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":"chosen","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":null}]}\n\n',
  'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":"chosen","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n',
  'data: [DONE]\n\n'
].join('')

const userMessage = {
  role: 'user' as const,
  content: [{ type: 'text' as const, text: 'ping' }],
  timestamp: 1
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
}

function requestBody(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>
}

function headerText(init: RequestInit | undefined): string {
  return JSON.stringify([...new Headers(init?.headers)])
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('Pi 模型运行时', () => {
  it('构造模型不访问网络，调用时使用已保存输出上限并禁止环境凭据', async () => {
    stubAmbientCredentials()
    const fetcher = vi.fn(
      async () =>
        new Response(openAiStream, {
          headers: { 'content-type': 'text/event-stream' }
        })
    )
    const loadSettings = vi.fn(async () => saved)
    const factory = new PiModelFactory(loadSettings, fetcher)

    expect(loadSettings).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
    const runtime = await factory.create()
    expect(loadSettings).toHaveBeenCalledTimes(1)
    expect(fetcher).not.toHaveBeenCalled()
    expect(runtime.profile).toEqual({
      providerId: 'openai-compatible',
      baseUrl: saved.baseUrl,
      model: 'chosen',
      contextWindow: 200000,
      maxOutputTokens: 32000,
      requestTimeoutMs: 240000
    })
    expect(runtime.model).toMatchObject({
      id: 'chosen',
      api: 'openai-completions',
      provider: 'openai',
      baseUrl: 'https://service.example/v1',
      contextWindow: 200000,
      maxTokens: 32000
    })
    expect(JSON.stringify(runtime.model)).not.toContain('stored-secret')

    const completion = await runtime
      .streamFn(runtime.model, normalizeContext({ messages: [userMessage] }))
      .result()
    expect(completion.stopReason).toBe('stop')
    expect(fetcher).toHaveBeenCalledTimes(1)
    const init = fetcher.mock.calls[0]?.[1]
    expect(String(fetcher.mock.calls[0]?.[0])).toBe('https://service.example/v1/chat/completions')
    expect(requestBody(init)).toMatchObject({ model: 'chosen', max_tokens: 32000 })
    expect(requestBody(init)).not.toHaveProperty('temperature')
    expect(requestBody(init)).not.toHaveProperty('top_p')
    expect(init?.redirect).toBe('error')
    const headers = new Headers(init?.headers)
    expect(headers.get('authorization')).toBe('Bearer stored-secret')
    expect(headers.get('openai-organization')).toBeNull()
    expect(headers.get('openai-project')).toBeNull()
    expect(headerText(init)).not.toContain('ambient')
  })

  it('Anthropic 使用消息接口和已保存密钥，不夹带环境令牌', async () => {
    stubAmbientCredentials()
    const fetcher = vi.fn(async () => new Response('{}', { status: 401 }))
    const runtime = await new PiModelFactory(
      async () => ({
        ...saved,
        providerId: 'anthropic',
        baseUrl: 'https://anthropic.example',
        model: 'claude-test',
        temperature: 0
      }),
      fetcher
    ).create({ user: { requestTimeoutMs: 180000 } })

    expect(runtime.profile).toMatchObject({
      providerId: 'anthropic',
      requestTimeoutMs: 180000,
      temperature: 0
    })
    expect(runtime.model).toMatchObject({
      api: 'anthropic-messages',
      provider: 'anthropic',
      baseUrl: 'https://anthropic.example'
    })
    const completion = await runtime
      .streamFn(runtime.model, normalizeContext({ messages: [userMessage] }))
      .result()
    expect(completion.stopReason).toBe('error')
    expect(fetcher).toHaveBeenCalledTimes(1)
    const init = fetcher.mock.calls[0]?.[1]
    const address = new URL(String(fetcher.mock.calls[0]?.[0]))
    expect(address.origin + address.pathname).toBe('https://anthropic.example/v1/messages')
    expect(requestBody(init)).toMatchObject({
      model: 'claude-test',
      max_tokens: 32000,
      temperature: 0
    })
    expect(init?.redirect).toBe('error')
    const headers = new Headers(init?.headers)
    expect(headers.get('x-api-key')).toBe('stored-secret')
    expect(headers.get('authorization')).toBeNull()
    expect(headers.get('x-stainless-timeout')).toBe('180')
    expect(headerText(init)).not.toContain('ambient')
  })

  it('已保存 top-p 进入 OpenAI 请求，本次覆盖优先', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(openAiStream, {
          headers: { 'content-type': 'text/event-stream' }
        })
    )
    const runtime = await new PiModelFactory(async () => ({ ...saved, topP: 0.9 }), fetcher).create(
      {
        user: { requestTimeoutMs: 180000 },
        override: { maxOutputTokens: 16000, requestTimeoutMs: 60000 }
      }
    )

    await runtime.streamFn(runtime.model, normalizeContext({ messages: [userMessage] })).result()
    const init = fetcher.mock.calls[0]?.[1]
    expect(requestBody(init)).toMatchObject({ max_tokens: 16000, top_p: 0.9 })
    expect(requestBody(init)).not.toHaveProperty('temperature')
    expect(runtime.profile.requestTimeoutMs).toBe(60000)
  })

  it('Anthropic 的 top-p 进入请求体，且不覆盖调用方已有 onPayload', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 401 }))
    const runtime = await new PiModelFactory(
      async () => ({
        ...saved,
        providerId: 'anthropic',
        baseUrl: 'https://anthropic.example',
        model: 'claude-test',
        topP: 0.7
      }),
      fetcher
    ).create()
    let observed = false
    await runtime
      .streamFn(runtime.model, normalizeContext({ messages: [userMessage] }), {
        onPayload: (payload) => {
          observed = true
          return payload
        }
      })
      .result()
    expect(observed).toBe(true)
    expect(requestBody(fetcher.mock.calls[0]?.[1])).toMatchObject({ top_p: 0.7 })
  })

  it('非法覆盖和采样冲突在发起请求前失败', async () => {
    const fetcher = vi.fn(async () => new Response(openAiStream))
    const factory = new PiModelFactory(async () => ({ ...saved, temperature: 0.4 }), fetcher)

    await expect(factory.create({ override: { requestTimeoutMs: 0 } })).rejects.toMatchObject({
      code: 1401,
      message: '单次请求超时必须为正整数'
    })
    await expect(factory.create({ override: { topP: 0.2 } })).rejects.toMatchObject({
      code: 1401,
      message: '温度与 top-p 只能填写一个'
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each(['openai-compatible', 'anthropic'] as const)(
    '%s 扩展进入真实请求且应用控制项不被改写',
    async (providerId) => {
      const session = 'fake-session'
      const stolenKey = 'stolen-key'
      const extensionFetch = vi.fn(async () => new Response('extension-fetch'))
      const fetcher = vi.fn(async () => {
        if (providerId === 'anthropic') return new Response('{}', { status: 401 })
        return new Response(openAiStream, { headers: { 'content-type': 'text/event-stream' } })
      })
      const baseUrl =
        providerId === 'anthropic' ? 'https://anthropic.example' : 'https://service.example/v1'
      const extension = {
        defaultHeaders: { 'x-opencode-session': session, 'User-Agent': 'custom-agent' },
        defaultQuery: { trace: 'request-marker' },
        fetchOptions: { cache: 'no-store', referrer: 'extension-referrer' }
      }
      const factory = new PiModelFactory(
        async () => ({
          ...saved,
          providerId,
          baseUrl,
          model: providerId === 'anthropic' ? 'claude-test' : saved.model,
          extension
        }),
        fetcher
      )
      const runtime = await factory.create({ override: { requestTimeoutMs: 1000 } })
      await runtime.streamFn(runtime.model, normalizeContext({ messages: [userMessage] })).result()

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
      if (providerId === 'anthropic') expect(headers.get('user-agent')).toBe('custom-agent')
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

  it('没有可用设置或密钥时不回退环境变量', async () => {
    stubAmbientCredentials()
    const fetcher = vi.fn(async () => new Response(openAiStream))
    const missing = new PiModelFactory(async () => null, fetcher)
    const blankKey = new PiModelFactory(async () => ({ ...saved, apiKey: ' ' }), fetcher)

    await expect(missing.create()).rejects.toMatchObject({
      code: ConnectionErrorCodes.invalidConnectionConfig,
      message: '当前没有可用的模型连接设置'
    })
    await expect(blankKey.create()).rejects.toMatchObject({
      code: ConnectionErrorCodes.invalidApiKey,
      message: 'API Key 不能为空'
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('已保存扩展含不会生效的键时，建模型前拒绝且不回显值', async () => {
    const secret = 'session-secret-value'
    const fetcher = vi.fn(async () => new Response(openAiStream))
    const factory = new PiModelFactory(
      async () => ({ ...saved, extension: { timeout: secret } }),
      fetcher
    )

    await expect(factory.create()).rejects.toMatchObject({
      code: 1401,
      message: expect.stringContaining('timeout')
    })
    await expect(factory.create()).rejects.not.toMatchObject({
      message: expect.stringContaining(secret)
    })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each(['openai-compatible', 'anthropic'] as const)(
    '%s 上游失败只请求一次',
    async (providerId) => {
      const fetcher = vi.fn(async () => new Response('no', { status: 500 }))
      const runtime = await new PiModelFactory(
        async () =>
          providerId === 'anthropic'
            ? { ...saved, providerId, baseUrl: 'https://anthropic.example', model: 'claude-test' }
            : saved,
        fetcher
      ).create()

      await runtime.streamFn(runtime.model, normalizeContext({ messages: [userMessage] })).result()
      expect(fetcher).toHaveBeenCalledTimes(1)
    }
  )
})
