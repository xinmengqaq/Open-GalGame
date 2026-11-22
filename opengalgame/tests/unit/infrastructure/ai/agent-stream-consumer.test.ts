import { describe, expect, it } from 'vitest'

import { createAgentStreamConsumer } from '@infrastructure/ai/streaming/AgentStreamConsumer'
import type {
  AgentStreamEvent,
  AgentStreamSubscriber
} from '@infrastructure/ai/streaming/AgentStreamEvent'

const event: AgentStreamEvent = {
  executionId: 'execution',
  agentId: 'agent',
  runId: 'run',
  sequence: 1,
  timestamp: 1,
  type: 'run',
  status: 'started'
}

describe('Agent 流订阅分发', () => {
  it('同步回调返回普通值时保留订阅并继续分发', () => {
    const consumer = createAgentStreamConsumer(() => undefined)
    let received = 0
    // 运行时 JS 回调可能返回任意值；类型声明之外的返回值不能当作 Promise。
    const subscriber = (() => {
      received += 1
      return 1
    }) as unknown as AgentStreamSubscriber
    consumer.subscribe(subscriber)

    consumer.dispatch(event)
    consumer.dispatch(event)

    expect(received).toBe(2)
    consumer.release()
  })
})
