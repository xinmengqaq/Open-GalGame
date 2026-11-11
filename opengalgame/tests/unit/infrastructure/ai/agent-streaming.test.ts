import { describe, expect, it, vi } from 'vitest'
import type { ProtocolEvent } from '@langchain/langgraph/stream'
import { GraphInterrupt } from '@langchain/langgraph'
import { createAgentStreamConsumer } from '@infrastructure/ai/streaming/AgentStreamConsumer'
import { LangChainEventStreamAdapter } from '@infrastructure/ai/streaming/LangChainEventStreamAdapter'
import { createConsoleAgentStreamLogger } from '@infrastructure/ai/streaming/ConsoleAgentStreamLogger'

describe('单次 Agent 观察', () => {
  it('同名工具调用按命名空间区分中断与真实错误，不依据错误文本判断', () => {
    const adapter = new LangChainEventStreamAdapter('execution', 'agent', false)
    const callbacks = adapter.callbacks(() => {})
    const event = (namespace: string, status: string): ProtocolEvent => ({
      type: 'event',
      seq: 1,
      method: 'tools',
      params: {
        namespace: [namespace],
        timestamp: Date.now(),
        data: {
          event: status,
          tool_call_id: 'same-id',
          tool_name: 'inspect',
          message: 'GraphInterrupt'
        }
      }
    })
    for (const namespace of ['tools:waiting', 'tools:failed']) {
      callbacks.handleToolStart!(
        { id: ['tool'], lc: 1, type: 'not_implemented' },
        '',
        namespace,
        undefined,
        undefined,
        { langgraph_checkpoint_ns: namespace },
        undefined,
        'same-id'
      )
      adapter.adapt(event(namespace, 'tool-started'))
    }
    callbacks.handleToolError!(new GraphInterrupt([]), 'tools:waiting')
    callbacks.handleToolError!(new Error('GraphInterrupt'), 'tools:failed')
    expect(adapter.adapt(event('tools:waiting', 'tool-error'))).toMatchObject([
      { status: 'interrupted' }
    ])
    expect(adapter.adapt(event('tools:failed', 'tool-error'))).toMatchObject([
      { status: 'failed', error: { category: 'tool' } }
    ])
    adapter.release()
  })
  it('控制台保留供应商限定的动态模型名称，不透传其他敏感字段', () => {
    const lines: string[] = []
    const log = createConsoleAgentStreamLogger({
      enabled: true,
      destination: {
        write: (line) => {
          lines.push(line)
        }
      }
    })
    const adapter = new LangChainEventStreamAdapter('execution', 'agent', false)
    log({
      ...adapter.start(),
      type: 'model',
      status: 'started',
      modelName: 'anthropic/claude-sonnet-4',
      prompt: 'private',
      apiKey: 'sk-secret'
    } as never)
    expect(JSON.parse(lines[0]).modelName).toBe('anthropic/claude-sonnet-4')
    expect(lines.join('')).not.toMatch(/private|sk-secret/)
  })
  it('订阅抛错留下安全诊断，不阻断其他订阅；退出和释放不再接收', async () => {
    const diagnostic = vi.fn()
    const consumer = createAgentStreamConsumer(diagnostic)
    consumer.subscribe(() => {
      throw new Error('sk-secret C:/private/prompt')
    })
    consumer.subscribe(async () => {
      throw new Error('secret')
    })
    const received = vi.fn()
    const leave = consumer.subscribe(received)
    const adapter = new LangChainEventStreamAdapter('execution', 'agent', false)
    consumer.dispatch(adapter.start())
    await Promise.resolve()
    expect(received).toHaveBeenCalledTimes(1)
    expect(diagnostic).toHaveBeenCalled()
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('secret')
    leave()
    consumer.dispatch(adapter.finish('succeeded'))
    expect(received).toHaveBeenCalledTimes(1)
    consumer.release()
    consumer.dispatch(adapter.start())
  })

  it('筛选状态和文本，省略缺失用量，不把普通子节点当成 Agent', () => {
    const adapter = new LangChainEventStreamAdapter('execution', 'agent', true)
    const event = (method: string, data: unknown, namespace: string[] = []): ProtocolEvent => ({
      type: 'event' as const,
      seq: 1,
      method,
      params: { namespace, timestamp: Date.now(), data }
    })
    expect(
      adapter.adapt(
        event('messages', { event: 'message-start', run_id: 'model-1', id: 'message-1' })
      )
    ).toMatchObject([
      { type: 'model', status: 'started', runId: 'model-1', messageId: 'message-1' }
    ])
    expect(
      adapter.adapt(
        event('messages', {
          event: 'content-block-delta',
          run_id: 'model-1',
          delta: { type: 'reasoning-delta', reasoning: 'secret' }
        })
      )
    ).toEqual([])
    expect(
      adapter.adapt(
        event('messages', {
          event: 'content-block-delta',
          run_id: 'model-1',
          delta: { type: 'text-delta', text: 'hello' }
        })
      )
    ).toMatchObject([{ type: 'text', text: 'hello' }])
    const finished = adapter.adapt(
      event('messages', {
        event: 'message-finish',
        run_id: 'model-1',
        responseMetadata: { secret: 'private' }
      })
    )
    expect(finished[0]).not.toHaveProperty('usage')
    expect(
      adapter.adapt(event('lifecycle', { event: 'started', graph_name: 'model' }, ['model:123']))
    ).toEqual([])
    expect(
      JSON.stringify(
        adapter.adapt(event('updates', { prompt: 'secret', checkpoints: ['private'] }))
      )
    ).not.toContain('secret')
    expect(adapter.finish('interrupted').status).toBe('interrupted')
    adapter.release()
  })

  it('控制台只输出筛选字段，不逐 Token 输出，禁用时无输出', () => {
    const lines: string[] = []
    const destination = {
      write: (line: string) => {
        lines.push(line)
      }
    }
    const log = createConsoleAgentStreamLogger({ enabled: true, destination })
    const adapter = new LangChainEventStreamAdapter('execution', 'agent', true)
    log(adapter.start())
    log({ ...adapter.start(), type: 'text', text: 'secret prompt' })
    log({
      ...adapter.start(),
      type: 'model',
      status: 'failed',
      error: { category: 'model', message: '模型调用失败' },
      unsafe: 'sk-secret'
    } as never)
    createConsoleAgentStreamLogger({ enabled: false, destination })(adapter.start())
    expect(lines).toHaveLength(2)
    expect(lines.join('')).not.toContain('secret')
    expect(lines.join('')).toContain('executionId')
  })
})
