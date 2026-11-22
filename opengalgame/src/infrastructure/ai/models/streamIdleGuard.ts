import { AttemptTimedOut } from '../execution/executionErrors'

export const defaultStreamIdleTimeoutMs = 600_000

interface IdleGuardOptions {
  idleTimeoutMs: number
  signal: AbortSignal
  abortRequest: (reason: unknown) => void
  release: () => void
}

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
