import { describe, expect, it, vi } from 'vitest'

import { Agent, type AgentMessage, type AgentTool } from '@earendil-works/pi-agent-core'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxProviderHandle
} from '@earendil-works/pi-ai/providers/faux'

import type { AgentProgressEvent } from '@infrastructure/ai/execution/AgentProgress'
import { ExecutionBudget } from '@infrastructure/ai/execution/ExecutionBudget'
import { PiAgentFactory } from '@infrastructure/ai/pi/PiAgentFactory'
import { PiAgentExecutor } from '@infrastructure/ai/pi/PiAgentExecutor'
import { PiModelFactory, type PiModelRuntime } from '@infrastructure/ai/pi/PiModelFactory'
import type { AgentStreamEvent } from '@infrastructure/ai/streaming/AgentStreamEvent'
import type { ConnectionSettingsInfo } from '@domain/connections/models/ConnectionSettings'

const identity = { executionId: 'execution-1', agentId: 'webgal-scene', runId: 'run-1' }

const openAiStream = [
  'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":"chosen","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":null}]}\n\n',
  'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":"chosen","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n',
  'data: [DONE]\n\n'
].join('')

function createRuntime(faux: FauxProviderHandle): PiModelRuntime {
  const model = faux.getModel()
  return {
    model,
    profile: {
      providerId: 'openai-compatible',
      baseUrl: model.baseUrl,
      model: model.id,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxTokens
    },
    streamFn: faux.provider.streamSimple
  }
}

function createExecutor(faux: FauxProviderHandle): PiAgentExecutor {
  return new PiAgentExecutor({
    runtime: createRuntime(faux),
    createAgent: (options) => new Agent(options)
  })
}

function textOf(message: AssistantMessage | undefined): string {
  if (!message) return ''
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

function toolResultOf(messages: readonly AgentMessage[]): AgentMessage | undefined {
  return messages.find((message) => message.role === 'toolResult')
}

describe('Pi Agent 执行入口', () => {
  it('注入系统提示、历史消息、本次输入和工具，并映射事件与预算', async () => {
    const faux = fauxProvider()
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('record', { value: 'x' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('done')
    ])
    const received: unknown[] = []
    const tool: AgentTool = {
      name: 'record',
      label: 'record',
      description: '记录一个值',
      parameters: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value']
      },
      execute: async (_toolCallId, params) => {
        received.push(params)
        return { content: [{ type: 'text', text: 'ok' }], details: {} }
      }
    }
    const budget = new ExecutionBudget({ modelAttempts: 10, toolCalls: 10, activeMs: 60_000 })
    const events: AgentStreamEvent[] = []
    const progress: AgentProgressEvent[] = []
    const result = await createExecutor(faux).run({
      systemPrompt: 'SYS',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'history' }], timestamp: 1 }],
      prompt: 'NOW',
      tools: [tool],
      signal: new AbortController().signal,
      identity,
      budget,
      progress: (event) => progress.push(event),
      observation: {
        textDeltas: true,
        subscriptions: [{ onEvent: (event) => events.push(event) }]
      }
    })

    expect(received).toEqual([{ value: 'x' }])
    expect(result.status).toBe('succeeded')
    expect(result.stopReason).toBe('stop')
    expect(result.assistant).toBeDefined()
    expect(textOf(result.assistant)).toBe('done')
    expect(result.messages[0]?.role).toBe('system')
    expect(result.messages.filter((message) => message.role === 'user')).toHaveLength(2)
    expect(toolResultOf(result.messages)).toMatchObject({ role: 'toolResult', isError: false })
    expect(budget.usage.modelAttempts).toBe(2)
    expect(budget.usage.toolCalls).toBe(1)
    expect(budget.usage.tokens).toBeGreaterThan(0)

    const runEvents = events.filter((event) => event.type === 'run')
    expect(runEvents).toHaveLength(2)
    expect(runEvents[0]).toMatchObject({ status: 'started' })
    expect(runEvents[1]).toMatchObject({ status: 'succeeded' })
    expect(
      events.filter((event) => event.type === 'model' && event.status === 'started')
    ).toHaveLength(2)
    expect(
      events.filter((event) => event.type === 'model' && event.status === 'succeeded')
    ).toHaveLength(2)
    expect(
      events.filter((event) => event.type === 'tool' && event.status === 'started')
    ).toHaveLength(1)
    expect(
      events.filter((event) => event.type === 'tool' && event.status === 'succeeded')
    ).toHaveLength(1)
    expect(events.some((event) => event.type === 'text')).toBe(true)
    expect(events.map((event) => event.sequence)).toEqual(
      [...events.map((event) => event.sequence)].sort((left, right) => left - right)
    )
    expect(events[events.length - 1]).toMatchObject({ type: 'run', status: 'succeeded' })
    expect(progress.map((event) => event.kind)).toEqual([
      'model-start',
      'model-end',
      'tool-start',
      'tool-end',
      'model-start',
      'model-end'
    ])
  })

  it('启动前已取消时不创建模型请求', async () => {
    const faux = fauxProvider()
    const controller = new AbortController()
    controller.abort()
    const events: AgentStreamEvent[] = []
    const result = await createExecutor(faux).run({
      prompt: 'NOW',
      tools: [],
      signal: controller.signal,
      identity,
      observation: { subscriptions: [{ onEvent: (event) => events.push(event) }] }
    })

    expect(faux.state.callCount).toBe(0)
    expect(result.status).toBe('cancelled')
    expect(result.messages).toEqual([])
    expect(events.filter((event) => event.type === 'run')).toEqual([
      expect.objectContaining({ status: 'started' }),
      expect.objectContaining({ status: 'cancelled' })
    ])
    expect(events.some((event) => event.type === 'model')).toBe(false)
  })

  it('工具执行中取消后，迟到结果被覆盖为中断且不推进终态', async () => {
    const faux = fauxProvider()
    faux.setResponses([fauxAssistantMessage(fauxToolCall('slow', {}), { stopReason: 'toolUse' })])
    const controller = new AbortController()
    const started = Promise.withResolvers<void>()
    const tool: AgentTool = {
      name: 'slow',
      label: 'slow',
      description: '等待取消',
      parameters: { type: 'object', properties: {} },
      execute: async (_toolCallId, _params, signal) => {
        started.resolve()
        const aborted = Promise.withResolvers<void>()
        const onAbort = (): void => aborted.reject(new DOMException('aborted', 'AbortError'))
        if (signal?.aborted) onAbort()
        else signal?.addEventListener('abort', onAbort, { once: true })
        await aborted.promise
        return { content: [{ type: 'text', text: 'late-success' }], details: {} }
      }
    }
    const events: AgentStreamEvent[] = []
    const pending = createExecutor(faux).run({
      prompt: 'NOW',
      tools: [tool],
      signal: controller.signal,
      identity,
      observation: { subscriptions: [{ onEvent: (event) => events.push(event) }] }
    })

    await started.promise
    controller.abort()
    const result = await pending

    expect(result.status).toBe('cancelled')
    const toolEnd = events.find((event) => event.type === 'tool' && event.status === 'interrupted')
    expect(toolEnd).toBeDefined()
    expect(toolResultOf(result.messages)).toMatchObject({
      role: 'toolResult',
      isError: true,
      content: [{ type: 'text', text: '执行已取消，结果未确认' }]
    })
    const runEvents = events.filter((event) => event.type === 'run')
    expect(runEvents[runEvents.length - 1]).toMatchObject({ status: 'cancelled' })
    expect(events[events.length - 1]).toMatchObject({ type: 'run', status: 'cancelled' })
  })

  it('工具失败作为错误结果回到模型，不自动中止后续回答', async () => {
    const faux = fauxProvider()
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('fail', {}), { stopReason: 'toolUse' }),
      fauxAssistantMessage('recovered')
    ])
    const tool: AgentTool = {
      name: 'fail',
      label: 'fail',
      description: '总是失败',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        throw new Error('tool failed')
      }
    }
    const events: AgentStreamEvent[] = []
    const result = await createExecutor(faux).run({
      prompt: 'NOW',
      tools: [tool],
      signal: new AbortController().signal,
      identity,
      observation: { subscriptions: [{ onEvent: (event) => events.push(event) }] }
    })

    expect(result.status).toBe('succeeded')
    expect(textOf(result.assistant)).toBe('recovered')
    expect(toolResultOf(result.messages)).toMatchObject({
      role: 'toolResult',
      isError: true
    })
    expect(
      events.filter((event) => event.type === 'tool' && event.status === 'failed')
    ).toHaveLength(1)
  })

  it('拒绝冲突的系统提示、缺少输入和重复工具名', async () => {
    const faux = fauxProvider()
    const executor = createExecutor(faux)
    const base = {
      tools: [],
      signal: new AbortController().signal,
      identity
    }

    await expect(
      executor.run({
        ...base,
        systemPrompt: 'SYS',
        messages: [{ role: 'system', content: [{ type: 'text', text: 'OTHER' }], timestamp: 1 }],
        prompt: 'NOW'
      })
    ).rejects.toMatchObject({
      code: 4101,
      message: '系统提示词与消息中的首条 system 消息只能保留一处'
    })
    await expect(executor.run({ ...base })).rejects.toMatchObject({
      code: 4101,
      message: '运行请求缺少输入消息'
    })
    await expect(
      executor.run({
        ...base,
        prompt: 'NOW',
        tools: [tool('same'), tool('same')]
      })
    ).rejects.toMatchObject({ code: 4101, message: '工具名称不能重复' })
    expect(faux.state.callCount).toBe(0)
  })

  it('创建 Agent 期间取消后不发起模型请求', async () => {
    const faux = fauxProvider()
    faux.setResponses([fauxAssistantMessage('should-not-run')])
    const controller = new AbortController()
    const executor = new PiAgentExecutor({
      runtime: createRuntime(faux),
      createAgent: (options) => {
        controller.abort()
        return new Agent(options)
      }
    })
    const events: AgentStreamEvent[] = []
    const result = await executor.run({
      prompt: 'NOW',
      tools: [],
      signal: controller.signal,
      identity,
      observation: { subscriptions: [{ onEvent: (event) => events.push(event) }] }
    })

    expect(faux.state.callCount).toBe(0)
    expect(result.status).toBe('cancelled')
    const runEvents = events.filter((event) => event.type === 'run')
    expect(runEvents[runEvents.length - 1]).toMatchObject({ status: 'cancelled' })
  })

  it('工厂加载真实 Pi ESM 包并完成一次脚本化模型调用', async () => {
    const fetcher = vi.fn(
      async () => new Response(openAiStream, { headers: { 'content-type': 'text/event-stream' } })
    )
    const settings: ConnectionSettingsInfo = {
      providerId: 'openai-compatible',
      baseUrl: 'https://service.example/v1',
      model: 'chosen',
      contextWindow: 200000,
      maxOutputTokens: 32000,
      apiKey: 'stored-secret'
    }
    const executor = await new PiAgentFactory(
      new PiModelFactory(async () => settings, fetcher)
    ).create()
    const result = await executor.run({
      prompt: 'hello',
      tools: [],
      signal: new AbortController().signal,
      identity
    })

    expect(result.status).toBe('succeeded')
    expect(textOf(result.assistant)).toBe('OK')
    expect(result.usage).toMatchObject({ inputTokens: 3, outputTokens: 1, totalTokens: 4 })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})

function tool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: [], details: {} })
  }
}
