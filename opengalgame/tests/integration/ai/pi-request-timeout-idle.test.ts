import { expect, it } from 'vitest'
import { normalizeContext } from '@earendil-works/pi-ai'
import { PiModelFactory } from '@infrastructure/ai/pi/PiModelFactory'
import type { ConnectionSettingsInfo } from '@domain/connections/models/ConnectionSettings'

const saved: ConnectionSettingsInfo = {
  providerId: 'openai-compatible',
  baseUrl: 'https://service.example/v1',
  model: 'chosen',
  contextWindow: 200000,
  maxOutputTokens: 32000,
  apiKey: 'stored-secret'
}

const userMessage = {
  role: 'user' as const,
  content: [{ type: 'text' as const, text: 'ping' }],
  timestamp: 1
}

// 该集成用例刻意使用真实时钟：验证的是请求期限与 SSE 空闲计时器的真实边界，
// 假的计时器无法覆盖底层 SDK 与流包装的组合行为。延迟保持短且固定。
it('单次请求期限只约束响应头之前，不收紧 SSE 正文空闲上限', async () => {
  const encoder = new TextEncoder()
  const fetcher = async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => {
          controller.enqueue(
            encoder.encode(
              'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"chosen","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":null}]}\n\n'
            )
          )
          controller.enqueue(
            encoder.encode(
              'data: {"id":"x","object":"chat.completion.chunk","created":1,"model":"chosen","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n'
            )
          )
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
        }, 300)
      }
    })
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  }
  const runtime = await new PiModelFactory(async () => saved, fetcher).create({
    override: { requestTimeoutMs: 50 }
  })
  const completion = await runtime
    .streamFn(runtime.model, normalizeContext({ messages: [userMessage] }))
    .result()
  expect(completion.stopReason).toBe('stop')
}, 5000)
