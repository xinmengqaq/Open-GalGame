import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  defaultStreamIdleTimeoutMs,
  guardStreamIdle
} from '@infrastructure/ai/models/streamIdleGuard'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

interface ManualStream {
  body: ReadableStream<Uint8Array>
  push: (text: string) => void
  close: () => void
  cancelled: () => boolean
}

function manualStream(): ManualStream {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    start(inner) {
      controller = inner
    },
    cancel() {
      cancelled = true
    }
  })
  return {
    body,
    push: (text) => controller.enqueue(encoder.encode(text)),
    close: () => controller.close(),
    cancelled: () => cancelled
  }
}

function eventStream(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

function recordingFetcher(stream: ManualStream): {
  fetcher: typeof fetch
  signal: () => AbortSignal | null | undefined
} {
  let signal: AbortSignal | null | undefined
  const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    signal = init?.signal
    return eventStream(stream.body)
  }) as typeof fetch
  return { fetcher, signal: () => signal }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('流式空闲守卫', () => {
  it('空闲上限默认 600000ms', () => {
    expect(defaultStreamIdleTimeoutMs).toBe(600_000)
  })

  it('响应头已到、正文停发时按单次调用超时结束并中止底层请求', async () => {
    vi.useFakeTimers()
    const stream = manualStream()
    const { fetcher, signal } = recordingFetcher(stream)
    const guarded = guardStreamIdle(fetcher, 1000)
    const response = await guarded('https://service.example/v1/chat/completions')
    const reader = response.body!.getReader()

    stream.push('data: {"id":"chunk-1"}\n\n')
    const first = await reader.read()
    expect(decoder.decode(first.value)).toContain('chunk-1')

    const pending = reader.read().then(
      () => undefined,
      (error: unknown) => error
    )
    await vi.advanceTimersByTimeAsync(999)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    const error = await pending
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('单次调用超时')
    expect(signal()?.aborted).toBe(true)
    expect(stream.cancelled()).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('持续有数据块时不会误超时，正常关闭后清理计时器', async () => {
    vi.useFakeTimers()
    const stream = manualStream()
    const { fetcher } = recordingFetcher(stream)
    const response = await guardStreamIdle(
      fetcher,
      1000
    )('https://service.example/v1/chat/completions')
    const reader = response.body!.getReader()

    for (let index = 0; index < 3; index++) {
      stream.push(`data: ${index}\n\n`)
      await vi.advanceTimersByTimeAsync(900)
      expect(decoder.decode((await reader.read()).value)).toContain(`data: ${index}`)
    }
    stream.close()
    expect(await reader.read()).toEqual({ done: true, value: undefined })
    expect(vi.getTimerCount()).toBe(0)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(stream.cancelled()).toBe(false)
  })

  it('取消读取时清理计时器并中止底层正文', async () => {
    vi.useFakeTimers()
    const stream = manualStream()
    const { fetcher, signal } = recordingFetcher(stream)
    const response = await guardStreamIdle(
      fetcher,
      1000
    )('https://service.example/v1/chat/completions')
    stream.push('data: one\n\n')
    const reader = response.body!.getReader()
    await reader.read()

    await reader.cancel()
    expect(vi.getTimerCount()).toBe(0)
    expect(stream.cancelled()).toBe(true)
    expect(signal()?.aborted).toBe(true)
  })

  it('调用方中止信号会清理计时器、结束读取并中止底层正文', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const stream = manualStream()
    const { fetcher } = recordingFetcher(stream)
    const response = await guardStreamIdle(fetcher, 1000)(
      'https://service.example/v1/chat/completions',
      { signal: controller.signal }
    )
    expect(response.body).not.toBeNull()
    const reader = response.body!.getReader()
    const pending = reader.read().then(
      () => undefined,
      (error: unknown) => error
    )

    controller.abort(new Error('caller aborted'))
    await vi.advanceTimersByTimeAsync(0)
    const error = await pending
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('caller aborted')
    expect(vi.getTimerCount()).toBe(0)
    expect(stream.cancelled()).toBe(true)
  })

  it('普通 JSON 响应原样返回，不安装空闲计时器', async () => {
    vi.useFakeTimers()
    const payload = { id: 'chatcmpl-1', choices: [] }
    const fetcher = (async () => Response.json(payload)) as typeof fetch

    const response = await guardStreamIdle(
      fetcher,
      1000
    )('https://service.example/v1/chat/completions')
    expect(await response.json()).toEqual(payload)
    expect(vi.getTimerCount()).toBe(0)
  })
})
