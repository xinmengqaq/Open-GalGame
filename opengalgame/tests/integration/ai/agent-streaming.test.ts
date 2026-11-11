import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  createAgent,
  createMiddleware,
  ToolMessage,
  tool,
  toolStrategy,
  type ReactAgent
} from 'langchain'
import { interrupt } from '@langchain/langgraph'
import { MemorySaver } from '@langchain/langgraph-checkpoint'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { Agent } from '@infrastructure/ai/agents/Agent'
import type { AgentDefinition } from '@infrastructure/ai/agents/AgentDefinition'
import type { AgentExecution } from '@infrastructure/ai/agents/AgentExecution'
import type { AgentExecutionOverride } from '@infrastructure/ai/config/agentExecutionConfig'
import { ExecutionBudget } from '@infrastructure/ai/execution/ExecutionBudget'
import { executionScope, agentInvocationScope } from '@infrastructure/ai/execution/executionScope'
import { LangChainAgentFactoryImpl } from '@infrastructure/ai/factories/LangChainAgentFactoryImpl'
import { LangChainModelFactory } from '@infrastructure/ai/models/LangChainModelFactory'
import { FilePromptLoader } from '@infrastructure/ai/prompts/FilePromptLoader'
import type { AgentStreamEvent } from '@infrastructure/ai/streaming/AgentStreamEvent'
import { streamingFetch } from './streamingFetch'

const roots: string[] = []
let executeTool: (text: string) => Promise<string> = async (text) => text
afterEach(async () => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  executeTool = async (text) => text
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('真实执行器的单次 v3 观察', () => {
  it('完整 Agent 输出转换结束前没有终态，转换抛错只发送失败', async () => {
    const failure = new Error('输出转换失败')
    const events: AgentStreamEvent[] = []
    class ConversionProbe extends ProbeAgent {
      async invoke(input: string, current: AgentExecution): Promise<never> {
        await super.invoke(input, current)
        await Promise.resolve()
        expect(terminals(events)).toEqual([])
        throw failure
      }
    }
    const fetcher = vi.fn(async () => Response.json(completion('done', 5)))
    const { agent, root } = await fixture(fetcher, ConversionProbe)
    await expect(agent.invoke('convert', execution(root, 'conversion', events))).rejects.toBe(
      failure
    )
    expect(terminals(events)).toMatchObject([{ status: 'failed' }])
    expect(terminals(events)).toHaveLength(1)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('两次模型一次工具，文本、实际用量和最终结果来自同一次执行', async () => {
    const tools = vi.fn(async (text: string) => text)
    executeTool = tools
    const fetcher = vi.fn(async (_url, init) => {
      const request = JSON.parse(String(init?.body))
      expect(request.stream).toBe(true)
      return Response.json(
        request.messages.at(-1).role === 'tool'
          ? completion('done', 5)
          : completion(null, 7, [{ id: 'tool-1', name: 'inspect', text: 'private tool input' }])
      )
    })
    const { agent, root } = await fixture(fetcher)
    const events: AgentStreamEvent[] = []
    const current = execution(root, 'one', events)
    const finish = vi.spyOn(current.context.budget, 'finishRun')
    const output = await agent.invoke('private prompt', current)
    expect(JSON.stringify(output.messages.at(-1)?.content)).toContain('done')
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(tools).toHaveBeenCalledTimes(1)
    expect(finish).toHaveBeenCalledTimes(1)
    expect(current.context.budget.usage).toMatchObject({
      modelAttempts: 2,
      toolCalls: 1,
      tokens: 12
    })
    const modelEnds = events.filter(
      (event) => event.type === 'model' && event.status === 'succeeded'
    )
    expect(modelEnds).toHaveLength(2)
    expect(new Set(modelEnds.map((event) => event.runId)).size).toBe(2)
    expect(modelEnds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
          modelName: 'chosen'
        })
      ])
    )
    const toolEvents = events.filter((event) => event.type === 'tool')
    expect(toolEvents.map((event) => event.status)).toEqual(['started', 'succeeded'])
    expect(toolEvents.every((event) => event.toolCallId === 'tool-1')).toBe(true)
    expect(
      events
        .filter((event) => event.type === 'text')
        .map((event) => event.text)
        .join('')
    ).toBe('done')
    expect(
      events.every((event) => event.executionId === 'one' && event.agentId === 'stream-probe')
    ).toBe(true)
    expect(events.map((event) => event.sequence)).toEqual(
      [...events.map((event) => event.sequence)].sort((a, b) => a - b)
    )
    expect(terminals(events)).toMatchObject([{ status: 'succeeded' }])
    expect(JSON.stringify(events)).not.toContain('private')
    expect(JSON.stringify(events)).not.toContain('sk-credential')
    expect(executionScope.getStore()).toBeUndefined()
    expect(agentInvocationScope.getStore()).toBeUndefined()
  })

  it('并发执行和并行工具各自关联，预算及订阅不串用，普通节点不是子 Agent', async () => {
    const fetcher = vi.fn(async (_url, init) => {
      const request = JSON.parse(String(init?.body))
      const prompt = request.messages.find((message) => message.role === 'user').content
      return Response.json(
        request.messages.at(-1).role === 'tool'
          ? completion(prompt, 2)
          : completion(null, 3, [
              { id: 'parallel-a', name: 'inspect', text: 'a' },
              { id: 'parallel-b', name: 'inspect', text: 'b' }
            ])
      )
    })
    const { agent, root } = await fixture(fetcher)
    const left: AgentStreamEvent[] = []
    const right: AgentStreamEvent[] = []
    const leftRun = execution(root, 'left', left)
    const rightRun = execution(root, 'right', right)
    await Promise.all([agent.invoke('left', leftRun), agent.invoke('right', rightRun)])
    expect(fetcher).toHaveBeenCalledTimes(4)
    for (const [id, events, current] of [
      ['left', left, leftRun],
      ['right', right, rightRun]
    ] as const) {
      expect(events.every((event) => event.executionId === id)).toBe(true)
      expect(
        events.filter((event) => event.type === 'tool' && event.status === 'succeeded')
      ).toHaveLength(2)
      expect(
        new Set(events.filter((event) => event.type === 'tool').map((event) => event.toolCallId))
      ).toEqual(new Set(['parallel-a', 'parallel-b']))
      expect(current.context.budget.usage).toMatchObject({
        modelAttempts: 2,
        toolCalls: 2,
        tokens: 5
      })
      expect(events.filter((event) => event.type === 'run')).toHaveLength(2)
    }
    expect(left[0].runId).not.toBe(right[0].runId)
  })

  it('结构化输出保留，缺失供应商用量不补零，文本默认关闭', async () => {
    const fetcher = vi.fn(async (_url, init) => {
      const request = JSON.parse(String(init?.body))
      const name = request.tools[0].function.name
      return Response.json(
        completion(null, undefined, [{ id: 'structured-call', name, arguments: { answer: 'ok' } }])
      )
    })
    const { agent, root } = await fixture(fetcher, StructuredProbe)
    const events: AgentStreamEvent[] = []
    const current = execution(root, 'structured', events)
    current.observation!.textDeltas = false
    const output = await agent.invoke('structured', current)
    expect(output.structuredResponse).toEqual({ answer: 'ok' })
    expect(fetcher).toHaveBeenCalledTimes(1)
    const ends = events.filter((event) => event.type === 'model' && event.status === 'succeeded')
    expect(ends).toHaveLength(1)
    expect(ends[0]).not.toHaveProperty('usage')
    expect(events.some((event) => event.type === 'text')).toBe(false)
  })

  it('模型失败只有失败终态，安全事件不泄露供应商原始错误', async () => {
    const fetcher = vi.fn(async () =>
      Response.json(
        { error: { message: 'sk-credential C:/private prompt', type: 'authentication_error' } },
        { status: 401 }
      )
    )
    const { agent, root } = await fixture(fetcher)
    const events: AgentStreamEvent[] = []
    await expect(agent.invoke('fail', execution(root, 'failure', events))).rejects.toThrow(
      '模型鉴权失败'
    )
    expect(terminals(events)).toMatchObject([{ status: 'failed' }])
    expect(events.some((event) => event.type === 'model' && event.status === 'failed')).toBe(true)
    expect(JSON.stringify(events)).not.toContain('private')
    expect(JSON.stringify(events)).not.toContain('credential')
  })

  it('技术重试记录各次模型调用，只有一次 Agent 成功终态', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      let attempts = 0
      const fetcher = vi.fn(async () =>
        ++attempts === 1
          ? Response.json(
              { error: { message: 'private retry', type: 'api_error' } },
              { status: 503 }
            )
          : Response.json(completion('recovered', 5))
      )
      const { agent, root } = await fixture(fetcher, ProbeAgent, {
        technicalRetryCount: 1,
        technicalRetryDelayMs: 10000
      })
      const events: AgentStreamEvent[] = []
      const current = execution(root, 'retry', events)
      const pending = agent.invoke('retry', current)
      const assertion = expect(pending).resolves.toHaveProperty('messages')
      await vi.advanceTimersByTimeAsync(20000)
      await assertion
      expect(fetcher).toHaveBeenCalledTimes(2)
      expect(current.context.budget.usage).toMatchObject({ modelAttempts: 2, tokens: 5 })
      expect(
        events.filter((event) => event.type === 'model' && event.status === 'failed')
      ).toHaveLength(1)
      expect(
        events.filter((event) => event.type === 'model' && event.status === 'succeeded')
      ).toHaveLength(1)
      expect(terminals(events)).toMatchObject([{ status: 'succeeded' }])
    } finally {
      vi.useRealTimers()
    }
  })

  it('库确认的具名子 Agent 与普通模型节点区分，并关联父运行及工具调用', async () => {
    const childFetch = vi.fn(async () => Response.json(completion('child result', 2)))
    const childModel = await new LangChainModelFactory(
      async () => ({
        providerId: 'openai-compatible',
        baseUrl: 'https://test.example/v1',
        model: 'child-model',
        contextWindow: 8000,
        maxOutputTokens: 128,
        apiKey: 'local-placeholder'
      }),
      streamingFetch(childFetch)
    ).createModel()
    const child = createAgent({ model: childModel.model, tools: [], name: 'confirmed-child' })
    executeTool = async () => {
      await child.invoke({ messages: [{ role: 'user', content: 'child' }] })
      return 'child completed'
    }
    const fetcher = vi.fn(async (_url, init) => {
      const request = JSON.parse(String(init?.body))
      return Response.json(
        request.messages.at(-1).role === 'tool'
          ? completion('done', 2)
          : completion(null, 3, [{ id: 'spawn-child', name: 'inspect', text: 'child' }])
      )
    })
    const { agent, root } = await fixture(fetcher)
    const events: AgentStreamEvent[] = []
    await agent.invoke('parent', execution(root, 'parent', events))
    const childRuns = events.filter(
      (event) => event.type === 'run' && event.agentId === 'confirmed-child'
    )
    expect(childRuns).toHaveLength(2)
    expect(childRuns.map((event) => event.status)).toEqual(['started', 'succeeded'])
    expect(childRuns[0]).toMatchObject({ parentRunId: events[0].runId, toolCallId: 'spawn-child' })
    expect(childRuns[0].runId).toBe(childRuns[1].runId)
    expect(
      events.filter(
        (event) =>
          event.type === 'model' &&
          event.agentId === 'confirmed-child' &&
          event.status === 'succeeded'
      )
    ).toMatchObject([{ parentRunId: childRuns[0].runId, modelName: 'child-model' }])
    expect(childFetch).toHaveBeenCalledTimes(1)
    expect(terminals(events)).toMatchObject([{ status: 'succeeded' }])
  })

  it('工具失败后继续，单次工具失败不把整个 Agent 判成失败', async () => {
    executeTool = async () => {
      throw new Error('private tool failure')
    }
    const fetcher = vi.fn(async (_url, init) => {
      const request = JSON.parse(String(init?.body))
      return Response.json(
        request.messages.at(-1).role === 'tool'
          ? completion('continued', 2)
          : completion(null, 3, [{ id: 'failed-tool', name: 'inspect', text: 'a' }])
      )
    })
    const { agent, root } = await fixture(fetcher, RecoveringProbe)
    const events: AgentStreamEvent[] = []
    const output = await agent.invoke('tool failure', execution(root, 'tool-failure', events))
    expect(JSON.stringify(output.messages.at(-1)?.content)).toContain('continued')
    expect(events.some((event) => event.type === 'tool' && event.status === 'failed')).toBe(true)
    expect(terminals(events)).toMatchObject([{ status: 'succeeded' }])
    expect(JSON.stringify(events)).not.toContain('private')
  })

  it('订阅注销和日志输出失败不取消执行，也不阻断其他订阅', async () => {
    const fetcher = vi.fn(async () => Response.json(completion('ok', 5)))
    const { agent, root } = await fixture(fetcher, ProbeAgent, undefined, {
      write: () => {
        throw new Error('private logger')
      }
    })
    const diagnostic = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const events: AgentStreamEvent[] = []
    const left = new AbortController()
    const leaving = vi.fn(() => left.abort())
    const current = execution(root, 'unsubscribe', events)
    current.observation!.subscriptions = [
      { onEvent: leaving, signal: left.signal },
      {
        onEvent: () => {
          throw new Error('private subscriber')
        }
      },
      ...current.observation!.subscriptions!
    ]
    await expect(agent.invoke('ok', current)).resolves.toHaveProperty('messages')
    expect(leaving).toHaveBeenCalledTimes(1)
    expect(terminals(events)).toMatchObject([{ status: 'succeeded' }])
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private')
    expect(diagnostic).toHaveBeenCalled()
  })

  it('输出等待期间保持作用域与预算，结算失败前不报告成功，合并原始与清理失败', async () => {
    let observedScope = false
    const fetcher = vi.fn(async () => {
      observedScope = executionScope.getStore()?.context?.budget !== undefined
      return Response.json({ error: { message: 'provider', type: 'api_error' } }, { status: 401 })
    })
    const { agent, root } = await fixture(fetcher)
    const events: AgentStreamEvent[] = []
    const current = execution(root, 'cleanup', events)
    const cleanup = new Error('cleanup failed')
    const finish = current.context.budget.finishRun.bind(current.context.budget)
    vi.spyOn(current.context.budget, 'finishRun').mockImplementation(() => {
      finish()
      throw cleanup
    })
    const error = await agent.invoke('fail', current).catch((error: unknown) => error)
    expect(error).toHaveProperty('cause')
    const cause = (error as { cause: AggregateError }).cause
    expect(cause).toBeInstanceOf(AggregateError)
    expect(cause.errors).toHaveLength(2)
    expect(cause.errors[1]).toBe(cleanup)
    expect(error).toMatchObject({ diagnosticCategory: 'auth' })
    expect(observedScope).toBe(true)
    expect(terminals(events)).toMatchObject([{ status: 'failed' }])
    const settled = current.context.budget.usage.activeMs
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(current.context.budget.usage.activeMs).toBe(settled)
  })

  it('SSE 持续消费期间保留作用域和活跃计时，完成后只结算一次', async () => {
    const events: AgentStreamEvent[] = []
    let scoped = false
    const fetcher = vi.fn(async (_url, init) => {
      const response = await streamingFetch(async () => Response.json(completion('streamed', 5)))(
        _url,
        init
      )
      const chunks = (await response.text()).split('\n\n').filter(Boolean)
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(chunks.slice(0, 2).join('\n\n') + '\n\n'))
            setTimeout(() => {
              controller.enqueue(new TextEncoder().encode(chunks.slice(2).join('\n\n') + '\n\n'))
              controller.close()
            }, 25)
          }
        }),
        { headers: { 'content-type': 'text/event-stream' } }
      )
    })
    const { agent, root } = await fixture(fetcher)
    const current = execution(root, 'live-stream', events)
    const finish = vi.spyOn(current.context.budget, 'finishRun')
    current.observation!.subscriptions = [
      {
        onEvent: (event) => {
          events.push(event)
          if (event.type === 'text') {
            scoped = executionScope.getStore()?.context?.budget === current.context.budget
            expect(finish).not.toHaveBeenCalled()
          }
        }
      }
    ]
    const output = await agent.invoke('stream', current)
    expect(JSON.stringify(output.messages.at(-1)?.content)).toContain('streamed')
    expect(scoped).toBe(true)
    expect(finish).toHaveBeenCalledTimes(1)
    expect(current.context.budget.usage.activeMs).toBeGreaterThanOrEqual(25)
    expect(current.context.budget.usage.tokens).toBe(5)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('模型输出成功但预算结算失败或 Token 用尽时，根终态仍为失败', async () => {
    const fetcher = vi.fn(async () => Response.json(completion('done', 5)))
    const { agent, root } = await fixture(fetcher)
    const events: AgentStreamEvent[] = []
    const current = execution(root, 'settlement', events)
    const finish = current.context.budget.finishRun.bind(current.context.budget)
    vi.spyOn(current.context.budget, 'finishRun').mockImplementation(() => {
      finish()
      throw new Error('private settlement')
    })
    await expect(agent.invoke('done', current)).rejects.toThrow('执行清理失败')
    expect(terminals(events)).toMatchObject([{ status: 'failed' }])
    const limited = await fixture(fetcher, ProbeAgent, { cumulativeTokenLimit: 4 })
    const limitedEvents: AgentStreamEvent[] = []
    await expect(
      limited.agent.invoke('budget', execution(limited.root, 'token-limit', limitedEvents))
    ).rejects.toThrow('累计 token 已用尽')
    expect(terminals(limitedEvents)).toMatchObject([{ status: 'failed' }])
  })

  it('取消与活跃时限分开，终态只一次，取消信号监听释放', async () => {
    const fetcher = vi.fn(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal
          if (signal?.aborted) reject(signal.reason)
          else signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
    )
    const { agent, root } = await fixture(fetcher, ProbeAgent, { activeLimitMs: 30 })
    const limitedEvents: AgentStreamEvent[] = []
    await expect(
      agent.invoke('timeout', execution(root, 'limited', limitedEvents))
    ).rejects.toThrow('活跃执行时间已用尽')
    expect(terminals(limitedEvents)).toMatchObject([{ status: 'failed' }])
    const events: AgentStreamEvent[] = []
    const current = execution(root, 'cancel', events)
    const controller = new AbortController()
    current.signal = controller.signal
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const pending = agent.invoke('cancel', current)
    controller.abort()
    await expect(pending).rejects.toThrow('执行已取消')
    expect(terminals(events)).toMatchObject([{ status: 'cancelled' }])
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('LangGraph 人工中断保留独立终态', async () => {
    executeTool = async () => interrupt('private interrupt payload')
    const fetcher = vi.fn(async () =>
      Response.json(completion(null, 3, [{ id: 'wait-tool', name: 'inspect', text: 'wait' }]))
    )
    const { agent, root } = await fixture(fetcher)
    const events: AgentStreamEvent[] = []
    await agent.invoke('wait', execution(root, 'interrupt', events))
    expect(terminals(events)).toMatchObject([{ status: 'interrupted' }])
    expect(events.filter((event) => event.type === 'tool').map((event) => event.status)).toEqual([
      'started',
      'interrupted'
    ])
    expect(
      events.find((event) => event.type === 'tool' && event.status === 'interrupted')
    ).not.toHaveProperty('error')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(events)).not.toContain('private')
  })
})

class ProbeAgent implements Agent<
  string,
  { messages: Array<{ content: unknown }>; structuredResponse?: unknown }
> {
  static readonly definition: AgentDefinition = {
    id: 'stream-probe',
    prompt: { agentId: 'stream-probe' },
    createTools: () => [
      tool(async ({ text }: { text: string }) => executeTool(text), {
        name: 'inspect',
        description: '测试通用工具',
        schema: z.object({ text: z.string() })
      })
    ],
    execution: { technicalRetryCount: 0 }
  }
  constructor(private readonly executor: ReactAgent) {}
  async invoke(
    input: string,
    execution: AgentExecution
  ): Promise<{ messages: Array<{ content: unknown }>; structuredResponse?: unknown }> {
    return this.executor.invoke(
      { messages: [{ role: 'user', content: input }] },
      {
        context: execution.context,
        signal: execution.signal,
        configurable: { thread_id: execution.scope.threadId }
      }
    )
  }
}

class StructuredProbe extends ProbeAgent {
  static readonly definition: AgentDefinition = {
    ...ProbeAgent.definition,
    createTools: () => [],
    responseFormat: toolStrategy(z.object({ answer: z.string() }))
  }
}

class RecoveringProbe extends ProbeAgent {
  static readonly definition: AgentDefinition = {
    ...ProbeAgent.definition,
    middleware: [
      createMiddleware({
        name: 'recoverTool',
        wrapToolCall: async (request, handler) => {
          try {
            return await handler(request)
          } catch {
            return new ToolMessage({
              content: '工具失败后继续',
              status: 'error',
              tool_call_id: request.toolCall.id!
            })
          }
        }
      })
    ]
  }
}

async function fixture(
  fetcher: typeof fetch,
  implementation = ProbeAgent,
  override?: AgentExecutionOverride,
  destination?: { write: (line: string) => void }
): Promise<{
  agent: Agent<string, { messages: Array<{ content: unknown }>; structuredResponse?: unknown }>
  root: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'stream-probe-'))
  roots.push(root)
  await mkdir(join(root, 'stream-probe'))
  await writeFile(join(root, 'stream-probe', 'system.md'), '通用测试提示')
  const factory = new LangChainAgentFactoryImpl(
    new LangChainModelFactory(
      async () => ({
        providerId: 'openai-compatible',
        baseUrl: 'https://test.example/v1',
        model: 'chosen',
        contextWindow: 8000,
        maxOutputTokens: 128,
        apiKey: 'sk-credential'
      }),
      streamingFetch(fetcher)
    ),
    new FilePromptLoader(root),
    { enabled: destination !== undefined, destination }
  )
  return {
    agent: await factory.create(implementation, { override, checkpointer: new MemorySaver() }),
    root
  }
}

function execution(root: string, id: string, events: AgentStreamEvent[]): AgentExecution {
  return {
    identity: { executionId: id },
    scope: { threadId: id },
    context: {
      budget: new ExecutionBudget({ modelAttempts: 8, toolCalls: 8, activeMs: 900000 }),
      workspace: { root, writable: false }
    },
    observation: {
      textDeltas: true,
      subscriptions: [
        {
          onEvent: (event) => {
            events.push(event)
          }
        }
      ]
    }
  }
}

function terminals(events: AgentStreamEvent[]): AgentStreamEvent[] {
  return events.filter(
    (event) => event.type === 'run' && event.status !== 'started' && !event.parentRunId
  )
}

function completion(
  text: string | null,
  tokens?: number,
  calls?: Array<{ id: string; name: string; text?: string; arguments?: unknown }>
): Record<string, unknown> {
  return {
    id: randomUUID(),
    object: 'chat.completion',
    model: 'chosen',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text,
          ...(calls
            ? {
                tool_calls: calls.map((call) => ({
                  id: call.id,
                  type: 'function',
                  function: {
                    name: call.name,
                    arguments: JSON.stringify(call.arguments ?? { text: call.text })
                  }
                }))
              }
            : {})
        },
        finish_reason: calls ? 'tool_calls' : 'stop'
      }
    ],
    ...(tokens === undefined
      ? {}
      : { usage: { prompt_tokens: tokens - 2, completion_tokens: 2, total_tokens: tokens } })
  }
}
