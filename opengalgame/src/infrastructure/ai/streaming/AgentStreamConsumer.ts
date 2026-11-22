import type { AgentStreamEvent, AgentStreamSubscriber } from './AgentStreamEvent'

export type AgentStreamDiagnostic = (message: string) => void

export function reportAgentStreamFault(message: string): void {
  try {
    process.stderr.write(`${message}\n`)
  } catch {
  }
}

export function createAgentStreamConsumer(
  diagnostic: AgentStreamDiagnostic = reportAgentStreamFault
): {
  subscribe: (onEvent: AgentStreamSubscriber, signal?: AbortSignal) => () => void
  dispatch: (event: AgentStreamEvent) => void
  release: () => void
} {
  const subscriptions = new Set<{ onEvent: AgentStreamSubscriber; leave: () => void }>()
  let released = false
  const report = (): void => {
    try {
      diagnostic('Agent 观察订阅输出失败')
    } catch {
    }
  }
  return {
    subscribe(onEvent: AgentStreamSubscriber, signal?: AbortSignal): () => void {
      if (released || signal?.aborted) return () => {}
      const leave = (): void => {
        subscriptions.delete(subscription)
        signal?.removeEventListener('abort', leave)
      }
      const subscription = { onEvent, leave }
      subscriptions.add(subscription)
      signal?.addEventListener('abort', leave, { once: true })
      return leave
    },
    dispatch(event: AgentStreamEvent): void {
      if (released) return
      for (const subscription of subscriptions) {
        try {
          const pending = subscription.onEvent(structuredClone(event))
          if (isPromiseLike(pending))
            void pending.catch(() => {
              subscription.leave()
              report()
            })
        } catch {
          subscription.leave()
          report()
        }
      }
    },
    release(): void {
      released = true
      for (const subscription of subscriptions) subscription.leave()
      subscriptions.clear()
    }
  }
}

/** 回调类型声明返回 void，但运行时可能返回任何值；只对 thenable 安装失败处理。 */
function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false
  return 'then' in value && typeof value.then === 'function'
}
