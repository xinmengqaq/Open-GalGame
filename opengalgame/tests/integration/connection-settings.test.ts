import { afterEach, describe, expect, it, vi } from 'vitest'

import { PiModelConnectionGatewayImpl } from '@infrastructure/ai/pi/PiModelConnectionGatewayImpl'
import { PiModelFactory } from '@infrastructure/ai/pi/PiModelFactory'
import { IpcErrorMapper } from '@interfaces/ipc/errors/IpcErrorMapper'

afterEach(() => {
  vi.unstubAllEnvs()
})

const settings = {
  providerId: 'openai-compatible' as const,
  baseUrl: 'https://service.example/v1',
  model: 'chosen',
  contextWindow: 128000,
  maxOutputTokens: 4096,
  apiKey: 'private'
}

const openAiStream = [
  'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":"chosen","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":null}]}\n\n',
  'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":"chosen","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n',
  'data: [DONE]\n\n'
].join('')

const anthropicStream = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg-test","type":"message","role":"assistant","model":"claude-test","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n'
].join('')

function finishReasonStream(finishReason: string): string {
  return [
    'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":"chosen","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":null}]}\n\n',
    `data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":"chosen","choices":[{"index":0,"delta":{},"finish_reason":${JSON.stringify(finishReason)}}]}\n\n`,
    'data: [DONE]\n\n'
  ].join('')
}

const streamWithoutFinishReason = [
  'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":"chosen","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":null}]}\n\n',
  'data: [DONE]\n\n'
].join('')

function streamResponse(body: string): Response {
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

function gateway(fetcher: typeof fetch, timeoutMs = 1000): PiModelConnectionGatewayImpl {
  return new PiModelConnectionGatewayImpl(
    new PiModelFactory(async () => settings, fetcher),
    timeoutMs,
    fetcher
  )
}

async function rejection(run: Promise<unknown>): Promise<unknown> {
  try {
    await run
  } catch (error) {
    return error
  }
  throw new Error('预期连接测试失败')
}

function failureText(error: unknown): string {
  const message = error instanceof Error ? error.message : undefined
  const reason =
    error instanceof Error && 'reason' in error && typeof error.reason === 'string'
      ? error.reason
      : undefined
  return JSON.stringify({ message, reason, causeMessage: errorCauseMessage(error) })
}

function errorCauseMessage(error: unknown): string | undefined {
  if (!(error instanceof Error) || !('cause' in error)) return undefined
  return error.cause instanceof Error ? error.cause.message : undefined
}

describe('Pi 连接协议适配', () => {
  it('测试连接用 Pi 运行时的流式补全请求', async () => {
    const fetcher = vi.fn(async () => streamResponse(openAiStream))
    expect(await gateway(fetcher).testConnection(settings)).toEqual({ available: true })
    expect(String(fetcher.mock.calls[0]?.[0])).toBe('https://service.example/v1/chat/completions')
    const init = fetcher.mock.calls[0]?.[1]
    const body = JSON.parse(init?.body as string) as Record<string, unknown>
    expect(body).toMatchObject({
      model: 'chosen',
      max_tokens: 1,
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'Reply with OK.' }]
    })
    expect(body).not.toHaveProperty('max_completion_tokens')
    expect(body).not.toHaveProperty('temperature')
    expect(body).not.toHaveProperty('top_p')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer private')
    expect(init?.redirect).toBe('error')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('测试连接由 Pi 运行时把输出上限固定为 1', async () => {
    const fetcher = vi.fn(async () => streamResponse(openAiStream))
    expect(await gateway(fetcher).testConnection({ ...settings, maxOutputTokens: 4096 })).toEqual({
      available: true
    })
    expect(JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string)).toMatchObject({
      max_tokens: 1,
      stream: true
    })
  })

  it('测试连接沿用 Pi 运行时绑定的已保存采样参数', async () => {
    const temperatureFetch = vi.fn(async () => streamResponse(openAiStream))
    expect(
      await gateway(temperatureFetch).testConnection({ ...settings, temperature: 0.4 })
    ).toEqual({ available: true })
    const temperatureBody = JSON.parse(
      temperatureFetch.mock.calls[0]?.[1]?.body as string
    ) as Record<string, unknown>
    expect(temperatureBody).toMatchObject({ max_tokens: 1, temperature: 0.4, stream: true })
    expect(temperatureBody).not.toHaveProperty('top_p')

    const topPFetch = vi.fn(async () => streamResponse(openAiStream))
    expect(await gateway(topPFetch).testConnection({ ...settings, topP: 0.9 })).toEqual({
      available: true
    })
    const topPBody = JSON.parse(topPFetch.mock.calls[0]?.[1]?.body as string) as Record<
      string,
      unknown
    >
    expect(topPBody).toMatchObject({ max_tokens: 1, top_p: 0.9, stream: true })
    expect(topPBody).not.toHaveProperty('temperature')
  })

  it('Anthropic 协议走消息接口和已保存密钥', async () => {
    const fetcher = vi.fn(async () => streamResponse(anthropicStream))
    expect(
      await gateway(fetcher).testConnection({
        ...settings,
        providerId: 'anthropic',
        baseUrl: 'https://anthropic.example',
        model: 'claude-test'
      })
    ).toEqual({ available: true })
    const address = new URL(String(fetcher.mock.calls[0]?.[0]))
    expect(address.origin + address.pathname).toBe('https://anthropic.example/v1/messages')
    const init = fetcher.mock.calls[0]?.[1]
    const headers = new Headers(init?.headers)
    expect(headers.get('x-api-key')).toBe('private')
    expect(headers.get('anthropic-version')).toBe('2023-06-01')
    expect(JSON.parse(init?.body as string)).toMatchObject({ model: 'claude-test', max_tokens: 1 })
    expect(init?.redirect).toBe('error')
  })

  it.each([
    [400, 1407],
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
    await expect(gateway(fetcher).testConnection(settings)).rejects.toMatchObject({ code })
    expect(fetcher.mock.calls).toHaveLength(1)
    await expect(gateway(fetcher).testConnection(settings)).rejects.not.toMatchObject({
      message: expect.stringContaining('provider-secret')
    })
  })

  it.each([
    ['content_filter', 'providerFinishReasonContentFilter'],
    ['network_error', 'providerFinishReasonNetworkError'],
    ['provider-secret', 'providerFinishReason']
  ])('2xx 流的 finish_reason %s 映射为可区分的安全分类', async (finishReason, reason) => {
    const fetcher = vi.fn(async () => streamResponse(finishReasonStream(finishReason)))
    const error = await rejection(gateway(fetcher).testConnection(settings))
    expect(error).toMatchObject({
      code: 1407,
      message: '模型服务未返回有效结果',
      reason
    })
    expect(errorCauseMessage(error)).toBe(reason)
    expect(failureText(error)).not.toContain('provider-secret')
  })

  it('2xx 流缺少 finish_reason 时映射为可区分的流错误', async () => {
    const fetcher = vi.fn(async () => streamResponse(streamWithoutFinishReason))
    const error = await rejection(gateway(fetcher).testConnection(settings))
    expect(error).toMatchObject({
      code: 1407,
      message: '模型服务未返回有效结果',
      reason: 'streamWithoutFinishReason'
    })
    expect(errorCauseMessage(error)).toBe('streamWithoutFinishReason')
  })

  it.each([400, 500])(
    '非特殊 HTTP %i 保留安全的状态分类与 cause，不泄漏响应内容',
    async (status) => {
      const fetcher = vi.fn(async () =>
        Response.json({ error: { message: 'provider-secret' } }, { status })
      )
      const error = await rejection(gateway(fetcher).testConnection(settings))
      const reason = `providerHttpStatus${status}`
      expect(error).toMatchObject({
        code: 1407,
        message: '模型服务未返回有效结果',
        reason
      })
      expect(errorCauseMessage(error)).toBe(reason)
      expect(failureText(error)).not.toContain('provider-secret')
    }
  )

  it('安全分类经 IPC 错误映射保留，可供界面和日志区分', async () => {
    const fetcher = vi.fn(async () => streamResponse(finishReasonStream('content_filter')))
    const error = await rejection(gateway(fetcher).testConnection(settings))
    expect(new IpcErrorMapper().map(error)).toEqual({
      code: 1407,
      msg: '模型服务未返回有效结果',
      reason: 'providerFinishReasonContentFilter'
    })
  })

  it('请求超时映射为连接超时', async () => {
    const pending = Promise.withResolvers<Response>()
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      init?.signal?.addEventListener('abort', () =>
        pending.reject(new DOMException('The operation was aborted.', 'AbortError'))
      )
      return pending.promise
    })
    await expect(
      gateway(fetcher as unknown as typeof fetch, 50).testConnection(settings)
    ).rejects.toMatchObject({ code: 1404, message: '连接测试超时' })
  })

  it('OpenAI 兼容协议按 /models 拉取模型 id', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        data: [{ id: 'plain' }, { id: ' long ', name: 'ignored' }]
      })
    )
    expect(await gateway(fetcher).listModels(settings)).toEqual({ models: ['plain', 'long'] })
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
    expect(
      await gateway(fetcher).listModels({
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
      await gateway(fetcher).listModels({ ...settings, providerId })
      const sent = JSON.stringify([...new Headers(fetcher.mock.calls[0]?.[1]?.headers)])
      expect(sent).not.toContain('ambient')
    }
  )

  it('上游未返回可用模型时映射为安全错误，不泄漏响应内容', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ data: [], error: { message: 'provider-secret' } })
    )
    await expect(gateway(fetcher).listModels(settings)).rejects.toMatchObject({ code: 1407 })
    expect(JSON.stringify(fetcher.mock.results)).not.toContain('provider-secret')
  })

  it('Anthropic 认证失败映射为安全错误码', async () => {
    const fetcher = vi.fn(async () =>
      Response.json(
        { type: 'error', error: { type: 'authentication_error', message: 'secret' } },
        { status: 401 }
      )
    )
    await expect(
      gateway(fetcher).testConnection({
        ...settings,
        providerId: 'anthropic',
        baseUrl: 'https://anthropic.example'
      })
    ).rejects.toMatchObject({ code: 1402 })
  })

  it('扩展只接受 Pi 实际生效的请求头、查询参数和 fetch 选项', async () => {
    const session = 'fake-session'
    const stolenKey = 'stolen-key'
    const extensionFetch = vi.fn(async () => new Response('extension-fetch'))
    const access = {
      ...settings,
      extension: {
        defaultHeaders: { 'x-opencode-session': session },
        defaultQuery: { trace: 'request-marker' },
        fetchOptions: { cache: 'no-store' }
      }
    }
    const testFetch = vi.fn(async () => streamResponse(openAiStream))
    const listFetch = vi.fn(async () => Response.json({ data: [{ id: 'listed' }] }))
    expect(await gateway(testFetch).testConnection(access)).toEqual({ available: true })
    expect(await gateway(listFetch).listModels(access)).toEqual({ models: ['listed'] })

    for (const fetcher of [testFetch, listFetch]) {
      const [url, init] = fetcher.mock.calls[0] ?? []
      const address = new URL(String(url))
      expect(address.origin).toBe('https://service.example')
      expect(address.searchParams.get('trace')).toBe('request-marker')
      const headers = new Headers(init?.headers)
      expect(headers.get('x-opencode-session')).toBe(session)
      expect(init?.cache).toBe('no-store')
      expect(init?.redirect).toBe('error')
      expect(headers.get('authorization')).toBe('Bearer private')
      expect(JSON.stringify([...headers])).not.toContain(stolenKey)
    }
    expect(extensionFetch).not.toHaveBeenCalled()
  })

  it.each(['openai-compatible', 'anthropic'] as const)(
    '%s 拒绝由应用控制或 Pi 不生效的扩展键',
    (providerId) => {
      const adapter = gateway(vi.fn())
      for (const key of ['logLevel', 'baseURL', 'apiKey', 'timeout', 'maxRetries']) {
        expect(() => adapter.validateProviderOptions(providerId, { [key]: 'off' })).toThrow()
      }
    }
  )
})
