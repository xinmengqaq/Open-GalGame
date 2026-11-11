import { AttemptTimedOut } from '../execution/executionErrors'

/**
 * 流式正文两次数据之间的最长空闲时间。响应头到达即开始计时，每次读到数据重新计时；
 * 与连接配置里的单次请求期限相互独立，后者只约束到达响应头之前的等待。
 */
export const defaultStreamIdleTimeoutMs = 600_000

interface IdleGuardOptions {
  idleTimeoutMs: number
  signal: AbortSignal
  abortRequest: (reason: unknown) => void
  release: () => void
}

/**
 * 只守护 SSE 流式正文：响应头已到但正文长时间没有新数据时，用既有单次调用超时错误结束读取，
 * 并中止底层请求。普通 JSON 响应原样返回，仍由调用方或 SDK 自身的响应期限约束。
 * @param fetcher - 实际发出请求的 fetch。
 * @param idleTimeoutMs - 两次正文数据之间允许的最长空闲时间。
 * @returns 带流式空闲守卫的 fetch。
 */
export function guardStreamIdle(
  fetcher: typeof fetch,
  idleTimeoutMs: number = defaultStreamIdleTimeoutMs
): typeof fetch {
  return async (input, init) => {
    const requestController = new AbortController()
    const callerSignal = init?.signal
    const forwardAbort = (): void => requestController.abort(callerSignal?.reason)
    if (callerSignal) {
      if (callerSignal.aborted) requestController.abort(callerSignal.reason)
      else callerSignal.addEventListener('abort', forwardAbort, { once: true })
    }
    const detachCaller = (): void => callerSignal?.removeEventListener('abort', forwardAbort)
    let response: Response
    try {
      response = await fetcher(input, { ...init, signal: requestController.signal })
    } catch (error) {
      detachCaller()
      throw error
    }
    if (response.body === null || !isEventStream(response)) return response
    const body = guardStreamBody(response.body, {
      idleTimeoutMs,
      signal: requestController.signal,
      abortRequest: (reason) => requestController.abort(reason),
      release: detachCaller
    })
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    })
  }
}

function isEventStream(response: Response): boolean {
  return response.headers.get('content-type')?.toLowerCase().includes('text/event-stream') ?? false
}

/**
 * 透传正文，同时把空闲到期、外部取消和读取失败收成同一次结算：清计时器、解绑监听、中止请求。
 * 结算后不再重复报错，避免动作方和读取方各抛一次。
 * @param body - 底层响应正文。
 * @param options - 空闲上限、请求信号和结算回调。
 * @returns 透传正文。
 */
function guardStreamBody(
  body: ReadableStream<Uint8Array>,
  options: IdleGuardOptions
): ReadableStream<Uint8Array> {
  const { idleTimeoutMs, signal, abortRequest, release } = options
  const reader = body.getReader()
  let timer: ReturnType<typeof setTimeout> | undefined
  let settled = false
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
  let arm: () => void = () => undefined

  const cleanup = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    signal.removeEventListener('abort', onAbort)
    release()
  }
  const settle = (): boolean => {
    if (settled) return false
    settled = true
    cleanup()
    return true
  }
  const onAbort = (): void => {
    if (!settle()) return
    streamController?.error(signal.reason)
    void reader.cancel(signal.reason).catch(() => undefined)
  }
  signal.addEventListener('abort', onAbort, { once: true })

  return new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller
      if (signal.aborted) {
        settle()
        controller.error(signal.reason)
        return
      }
      arm = (): void => {
        if (timer !== undefined) clearTimeout(timer)
        timer = setTimeout(() => {
          if (!settle()) return
          const error = new AttemptTimedOut()
          controller.error(error)
          abortRequest(error)
          void reader.cancel(error).catch(() => undefined)
        }, idleTimeoutMs)
      }
      arm()
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (settled) return
        if (done) {
          settle()
          controller.close()
          return
        }
        arm()
        controller.enqueue(value)
      } catch (error) {
        if (!settle()) return
        controller.error(error)
        abortRequest(error)
      }
    },
    cancel(reason) {
      if (!settle()) return
      abortRequest(reason)
      void reader.cancel(reason).catch(() => undefined)
    }
  })
}
