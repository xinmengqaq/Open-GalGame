import type { AgentStreamEvent, AgentStreamSubscriber } from './AgentStreamEvent'

export type AgentStreamDiagnostic = (message: string) => void

/** 写入固定中文诊断，不记录订阅抛出的原始异常。 */
export function reportAgentStreamFault(message: string): void {
  try {
    process.stderr.write(`${message}\n`)
  } catch {}
}

/**
 * 创建一次运行的订阅集合；回调不等待，不建立历史或待处理事件队列。
 * @param diagnostic - 只接收固定安全消息的本地诊断输出。
 * @returns 本次运行的注册、分发和释放函数。
 */
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
    } catch {}
  }
  return {
    /** 注册观察回调；注销信号只退出订阅，不影响任务。 */
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
    /** 按注册顺序分发副本，隔离同步和异步回调故障。 */
    dispatch(event: AgentStreamEvent): void {
      if (released) return
      for (const subscription of subscriptions) {
        try {
          const pending = subscription.onEvent(structuredClone(event))
          if (pending)
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
