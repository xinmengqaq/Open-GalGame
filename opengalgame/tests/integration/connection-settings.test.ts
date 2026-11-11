import { afterEach, describe, expect, it, vi } from 'vitest'

import { LangChainModelConnectionGatewayImpl } from '@infrastructure/connections/LangChainModelConnectionGatewayImpl'
import { mergeProviderClientOptions } from '@infrastructure/connections/mergeProviderClientOptions'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('LangChain 协议适配', () => {
  const settings = {
    providerId: 'openai-compatible' as const,
    baseUrl: 'https://service.example/v1',
    model: 'chosen',
    contextWindow: 128000,
    maxOutputTokens: 4096,
    apiKey: 'private'
  }
  it('OpenAI 兼容协议使用聊天补全路径和配置的上游', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: 1,
        model: 'chosen',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }
        ]
      })
    )
    const gateway = new LangChainModelConnectionGatewayImpl(1000, fetcher)
    expect(await gateway.testConnection(settings)).toEqual({ available: true })
    expect(String(fetcher.mock.calls[0]?.[0])).toBe('https://service.example/v1/chat/completions')
    const init = fetcher.mock.calls[0]?.[1]
    expect(JSON.parse(init?.body as string)).toMatchObject({ model: 'chosen' })
    expect(init?.redirect).toBe('error')
  })
  it('Anthropic 协议使用 messages 路径和独立的上游地址与 Key', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        id: 'msg-test',
        type: 'message',
        role: 'assistant',
        model: 'claude-test',
        content: [{ type: 'text', text: 'OK' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 4, output_tokens: 1 }
      })
    )
    const gateway = new LangChainModelConnectionGatewayImpl(1000, fetcher)
    expect(
      await gateway.testConnection({
        ...settings,
        providerId: 'anthropic',
        baseUrl: 'https://anthropic.example',
        model: 'claude-test'
      })
    ).toEqual({ available: true })
    expect(String(fetcher.mock.calls[0]?.[0])).toBe('https://anthropic.example/v1/messages')
    const init = fetcher.mock.calls[0]?.[1]
    expect(JSON.parse(init?.body as string)).toMatchObject({ model: 'claude-test', max_tokens: 1 })
    expect(init?.redirect).toBe('error')
  })
  it.each([
    [401, 1402],
    [403, 1402],
    [404, 1403],
    [429, 1406],
    [500, 1407]
  ])('上游 HTTP %i 映射到 %i，不泄漏响应内容', async (status, code) => {
    const fetcher = vi.fn(async () =>
      Response.json(
        { error: { message: 'provider-secret', type: 'invalid_request_error' } },
        { status }
      )
    )
    const gateway = new LangChainModelConnectionGatewayImpl(1000, fetcher)
    await expect(gateway.testConnection(settings)).rejects.toMatchObject({ code })
    expect(fetcher.mock.calls).toHaveLength(1)
  })
  it('OpenAI 兼容协议按 /models 拉取模型 id', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        data: [{ id: 'plain' }, { id: ' long ', name: 'ignored' }]
      })
    )
    const gateway = new LangChainModelConnectionGatewayImpl(1000, fetcher)
    expect(await gateway.listModels(settings)).toEqual({ models: ['plain', 'long'] })
    expect(String(fetcher.mock.calls[0]?.[0])).toBe('https://service.example/v1/models')
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: 'GET',
      redirect: 'error'
    })
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(
      'Bearer private'
    )
  })
  it('Anthropic 协议按 /v1/models 拉取模型 id', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        data: [{ id: 'claude-test', display_name: 'Claude Test' }]
      })
    )
    const gateway = new LangChainModelConnectionGatewayImpl(1000, fetcher)
    expect(
      await gateway.listModels({
        ...settings,
        providerId: 'anthropic',
        baseUrl: 'https://anthropic.example'
      })
    ).toEqual({ models: ['claude-test'] })
    expect(String(fetcher.mock.calls[0]?.[0])).toBe('https://anthropic.example/v1/models')
    const headers = new Headers(fetcher.mock.calls[0]?.[1]?.headers)
    expect(headers.get('x-api-key')).toBe('private')
    expect(headers.get('anthropic-version')).toBe('2023-06-01')
  })
  it.each(['anthropic', 'openai-compatible'] as const)(
    '%s 协议不把进程环境里的凭据带给上游',
    async (providerId) => {
      vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'ambient-anthropic-token')
      vi.stubEnv('ANTHROPIC_API_KEY', 'ambient-anthropic-key')
      vi.stubEnv('OPENAI_API_KEY', 'ambient-openai-key')
      vi.stubEnv('OPENAI_ORG_ID', 'ambient-org')
      vi.stubEnv('OPENAI_PROJECT_ID', 'ambient-project')
      const fetcher = vi.fn(async () => Response.json({ data: [{ id: 'listed' }] }))
      const gateway = new LangChainModelConnectionGatewayImpl(1000, fetcher)
      await gateway.listModels({ ...settings, providerId })
      const sent = JSON.stringify([...new Headers(fetcher.mock.calls[0]?.[1]?.headers)])
      expect(sent).not.toContain('ambient')
      vi.unstubAllEnvs()
    }
  )
  it('上游未返回可用模型时映射为安全错误，不泄漏响应内容', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ data: [], error: { message: 'provider-secret' } })
    )
    const gateway = new LangChainModelConnectionGatewayImpl(1000, fetcher)
    await expect(gateway.listModels(settings)).rejects.toMatchObject({ code: 1407 })
    expect(JSON.stringify(fetcher.mock.results)).not.toContain('provider-secret')
  })
  it('Anthropic 认证失败映射为安全错误码', async () => {
    const fetcher = vi.fn(async () =>
      Response.json(
        { type: 'error', error: { type: 'authentication_error', message: 'secret' } },
        { status: 401 }
      )
    )
    const gateway = new LangChainModelConnectionGatewayImpl(1000, fetcher)
    await expect(
      gateway.testConnection({
        ...settings,
        providerId: 'anthropic',
        baseUrl: 'https://anthropic.example'
      })
    ).rejects.toMatchObject({ code: 1402 })
  })

  it.each(['openai-compatible', 'anthropic'] as const)(
    '%s 的测试和拉列表都带扩展，且不能改写应用控制项',
    async (providerId) => {
      const session = 'fake-session'
      const stolenKey = 'stolen-key'
      const anthropic = providerId === 'anthropic'
      const extensionFetch = vi.fn(async () => new Response('extension-fetch'))
      const baseUrl = anthropic ? 'https://anthropic.example' : settings.baseUrl
      const extension = {
        defaultHeaders: { 'x-opencode-session': session },
        defaultQuery: { trace: 'request-marker' },
        fetchOptions: { cache: 'no-store' },
        logLevel: 'off',
        baseURL: 'https://override.example',
        apiKey: stolenKey,
        authToken: 'stolen-token',
        timeout: 1,
        maxRetries: 9,
        fetch: extensionFetch
      }
      const testFetch = vi.fn(async () =>
        anthropic
          ? Response.json({
              id: 'msg-test',
              type: 'message',
              role: 'assistant',
              model: 'claude-test',
              content: [{ type: 'text', text: 'OK' }],
              stop_reason: 'end_turn',
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 1 }
            })
          : Response.json({
              id: 'chatcmpl-test',
              choices: [{ index: 0, message: { role: 'assistant', content: 'OK' } }]
            })
      )
      expect(
        mergeProviderClientOptions(
          extension,
          {
            baseURL: baseUrl,
            apiKey: settings.apiKey,
            fetch: testFetch,
            maxRetries: 0
          },
          1000
        )
      ).toMatchObject({
        baseURL: baseUrl,
        apiKey: settings.apiKey,
        fetch: testFetch,
        timeout: 1000,
        maxRetries: 0,
        authToken: null
      })
      const listFetch = vi.fn(async () => Response.json({ data: [{ id: 'listed' }] }))
      const access = {
        ...settings,
        providerId,
        baseUrl,
        model: anthropic ? 'claude-test' : settings.model,
        extension: {
          defaultHeaders: extension.defaultHeaders,
          defaultQuery: extension.defaultQuery,
          fetchOptions: extension.fetchOptions,
          logLevel: extension.logLevel
        }
      }
      const tester = new LangChainModelConnectionGatewayImpl(1000, testFetch)
      const lister = new LangChainModelConnectionGatewayImpl(1000, listFetch)
      expect(await tester.testConnection(access)).toEqual({ available: true })
      expect(await lister.listModels(access)).toEqual({ models: ['listed'] })

      for (const fetcher of [testFetch, listFetch]) {
        const [url, init] = fetcher.mock.calls[0] ?? []
        const address = new URL(String(url))
        expect(address.origin).toBe(
          anthropic ? 'https://anthropic.example' : 'https://service.example'
        )
        expect(address.searchParams.get('trace')).toBe('request-marker')
        const headers = new Headers(init?.headers)
        expect(headers.get('x-opencode-session')).toBe(session)
        if (anthropic || address.pathname.endsWith('/chat/completions')) {
          expect(headers.get('x-stainless-timeout')).toBe('1')
        }
        expect(init?.cache).toBe('no-store')
        expect(init?.redirect).toBe('error')
        if (anthropic) expect(headers.get('x-api-key')).toBe('private')
        else expect(headers.get('authorization')).toBe('Bearer private')
        expect(JSON.stringify([...headers])).not.toContain(stolenKey)
      }
      expect(extensionFetch).not.toHaveBeenCalled()
    }
  )
})
