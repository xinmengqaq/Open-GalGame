import { streamingFetch } from './streamingFetch'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemorySaver } from '@langchain/langgraph-checkpoint'
import { Annotation, END, START, StateGraph } from '@langchain/langgraph'
import { createMiddleware, tool, toolStrategy, providerStrategy, type ReactAgent } from 'langchain'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import type { Agent } from '@infrastructure/ai/agents/Agent'
import type { AgentDefinition } from '@infrastructure/ai/agents/AgentDefinition'
import type { AgentExecution, AgentRunContext } from '@infrastructure/ai/agents/AgentExecution'
import { ExecutionBudget } from '@infrastructure/ai/execution/ExecutionBudget'
import { LangChainAgentFactoryImpl } from '@infrastructure/ai/factories/LangChainAgentFactoryImpl'
import { normalizeAgentError } from '@infrastructure/ai/middleware/retryPolicy'
import { LangChainModelFactory } from '@infrastructure/ai/models/LangChainModelFactory'
import { FilePromptLoader } from '@infrastructure/ai/prompts/FilePromptLoader'
import type { AgentStreamEvent } from '@infrastructure/ai/streaming/AgentStreamEvent'
import { runWorkflow } from '@infrastructure/workflow/execution/runWorkflow'
import type { ConnectionSettingsInfo } from '@domain/connections/models/ConnectionSettings'

const roots: string[] = []
const seenRoots: string[] = []
let toolCalls = 0

const saved: ConnectionSettingsInfo = {
  providerId: 'openai-compatible',
  baseUrl: 'https://service.example/v1',
  model: 'chosen',
  contextWindow: 200000,
  maxOutputTokens: 32000,
  apiKey: 'stored-secret'
}

afterEach(async () => {
  seenRoots.length = 0
  toolCalls = 0
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('LangChain Agent 工厂', () => {
  it.each([1, 2])('嵌套 %i 层真实图调用 Agent 共用预算且只计量一次', async (depth) => {
    const budget = budgetOf()
    const start = vi.spyOn(budget, 'startRun')
    const finish = vi.spyOn(budget, 'finishRun')
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(budget.hasOpenRun()).toBe(true)
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string }> }
      return Response.json(
        body.messages.at(-1)?.role === 'tool'
          ? textMessage('done')
          : toolMessage('echo', { text: 'hi' })
      )
    })
    const { factory, workspace } = await createFactory(fetcher)
    const agent = await factory.create(EchoAgent)
    const State = Annotation.Root({ value: Annotation<string>() })
    const child = new StateGraph(State)
      .addNode('agent', async (_state, config) => {
        const result = await agent.invoke(
          { prompt: 'run' },
          {
            ...execution(workspace, budget, 'nested-run', 'nested-thread'),
            signal: config.signal
          }
        )
        return { value: result.text }
      })
      .addEdge(START, 'agent')
      .addEdge('agent', END)
      .compile()
    const graph =
      depth === 1
        ? child
        : new StateGraph(State)
            .addNode('child', child)
            .addEdge(START, 'child')
            .addEdge('child', END)
            .compile()
    const events: AgentStreamEvent[] = []
    const result = await runWorkflow(
      graph,
      { value: '' },
      {
        identity: {
          projectId: 'project-a',
          threadId: 'thread-a',
          branchId: 'branch-a',
          operationId: 'operation-a'
        },
        budget,
        stateRoot: await createRoot(),
        recursionLimit: 12,
        ...(depth === 2
          ? {
              observation: {
                textDeltas: true,
                subscriptions: [
                  {
                    onEvent: (event: AgentStreamEvent) => {
                      events.push(event)
                    }
                  }
                ]
              }
            }
          : {})
      }
    )
    expect(result).toEqual({
      status: 'completed',
      output: { value: expect.stringContaining('done') }
    })
    if (depth === 2) {
      expect(
        events
          .filter((event) => event.type === 'text')
          .map((event) => event.text)
          .join('')
      ).toContain('done')
      expect(
        events.filter((event) => event.type === 'model' && event.status === 'succeeded')
      ).toHaveLength(2)
      expect(events.filter((event) => event.type === 'tool').map((event) => event.status)).toEqual([
        'started',
        'succeeded'
      ])
    }
    expect(start).toHaveBeenCalledTimes(1)
    expect(finish).toHaveBeenCalledTimes(1)
    expect(budget.hasOpenRun()).toBe(false)
    expect(budget.usage.modelAttempts).toBe(2)
    expect(budget.usage.toolCalls).toBe(1)
  })

  it('两个实现类共用工厂，创建时不访问模型或工具', async () => {
    const fetcher = vi.fn()
    const { factory } = await createFactory(fetcher)
    const echo = await factory.create(EchoAgent)
    const note = await factory.create(NoteAgent)

    expect(echo).toBeInstanceOf(EchoAgent)
    expect(note).toBeInstanceOf(NoteAgent)
    expect(fetcher).not.toHaveBeenCalled()
    expect(toolCalls).toBe(0)
  })

  it('真实执行器完成模型、工具、模型并让附加中间件看到本次上下文', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      bodies.push(body)
      const messages = body.messages as Array<{ role?: string }> | undefined
      const last = messages?.at(-1)
      if (last?.role === 'tool') return Response.json(textMessage('done'))
      return Response.json(toolMessage('echo', { text: 'hi' }))
    })
    const { factory, workspace } = await createFactory(fetcher)
    const agent = await factory.create(EchoAgent)
    const budget = budgetOf()
    const result = await agent.invoke(
      { prompt: 'ping' },
      execution(workspace, budget, 'run-1', 'thread-1')
    )

    expect(result.text).toContain('done')
    expect(toolCalls).toBe(1)
    expect(seenRoots).toContain(workspace)
    expect(JSON.stringify(bodies[0])).toContain('echo 提示')
    expect(JSON.stringify(bodies[0])).not.toContain('stored-secret')
    expect(budget.usage.modelAttempts).toBeGreaterThanOrEqual(2)
    expect(budget.usage.toolCalls).toBe(1)
  })

  it('结构化输出成功；不合法输出立即失败，不靠错误预算或图步数耗尽', async () => {
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      const names = toolNames(body)
      const structured = names.find((name) => name !== 'echo')
      const messages = body.messages as Array<{ role?: string }> | undefined
      if (messages?.some((message) => message.role === 'tool') && structured) {
        return Response.json(toolMessage(structured, { answer: 'ok' }))
      }
      if (names.includes('echo')) return Response.json(toolMessage('echo', { text: 'hi' }))
      return Response.json(toolMessage(structured ?? 'emit_result', { answer: 'ok' }))
    })
    const { factory, workspace } = await createFactory(fetcher)
    const agent = await factory.create(StructuredAgent)
    const result = await agent.invoke(
      { prompt: '结构' },
      execution(workspace, budgetOf(), 'run-structured', 'thread-structured')
    )
    expect(result.structured).toMatchObject({ answer: 'ok' })

    const invalidFetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      const structured = toolNames(body).find((name) => name !== 'echo') ?? 'emit_result'
      const messages = body.messages as Array<{ role?: string }> | undefined
      const planned = !messages?.some((message) => message.role === 'tool')
        ? { name: 'echo', args: { text: 'hi' } }
        : { name: structured, args: { wrong: true } }
      const forced = forcedToolName(body)
      if (forced && forced !== planned.name) throw new Error('模型替身忽略了 tool_choice')
      return Response.json(toolMessage(planned.name, planned.args))
    })
    const invalid = await (await createFactory(invalidFetcher)).factory.create(StructuredAgent)
    const invalidBudget = budgetOf()
    await expect(
      invalid.invoke({ prompt: '坏' }, execution(workspace, invalidBudget, 'run-bad', 'thread-bad'))
    ).rejects.toThrow('模型输出不符合约定')
    expect(invalidBudget.errorAttempts).toBe(1)
    expect(invalidFetcher).toHaveBeenCalledTimes(2)
    expect(invalidBudget.usage.modelAttempts).toBe(2)
  })

  it('结构化输出不强制 tool_choice，thinking 模型只接受 auto', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      bodies.push(body)
      if (body.tool_choice !== 'auto') {
        return Response.json(
          {
            error: {
              message: 'Thinking mode does not support this tool_choice',
              type: 'invalid_request_error'
            }
          },
          { status: 400 }
        )
      }
      const structured = toolNames(body).find((name) => name !== 'echo') ?? 'emit_result'
      return Response.json(toolMessage(structured, { answer: 'ok' }))
    })
    const { factory, workspace } = await createFactory(fetcher)
    const agent = await factory.create(StructuredAgent)
    const result = await agent.invoke(
      { prompt: '结构' },
      execution(workspace, budgetOf(), 'run-auto', 'thread-auto')
    )
    expect(result.structured).toMatchObject({ answer: 'ok' })
    expect(bodies.length).toBeGreaterThan(0)
    expect(bodies.every((body) => body.tool_choice === 'auto')).toBe(true)
  })

  it('不支持的结构化能力明确失败', async () => {
    const fetcher = vi.fn(async () =>
      Response.json(
        { error: { message: 'response_format is unsupported', type: 'invalid_request_error' } },
        { status: 400 }
      )
    )
    const { factory, workspace } = await createFactory(fetcher)
    const agent = await factory.create(UnsupportedAgent)

    await expect(
      agent.invoke({ prompt: '能力' }, execution(workspace, budgetOf(), 'run-un', 'thread-un'))
    ).rejects.toThrow('模型请求被拒绝')
  })

  it('不同执行不串工作区、预算或检查点状态', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return Response.json(textMessage('ok'))
    })
    const { factory } = await createFactory(fetcher)
    const checkpointer = new MemorySaver()
    const first = await factory.create(NoteAgent, { checkpointer })
    const left = await createRoot()
    const right = await createRoot()
    const leftBudget = budgetOf()
    const rightBudget = budgetOf()
    await first.invoke({ prompt: 'left-only' }, execution(left, leftBudget, 'left', 'thread-left'))
    await first.invoke(
      { prompt: 'right-only' },
      execution(right, rightBudget, 'right', 'thread-right')
    )
    const second = await factory.create(NoteAgent, { checkpointer })
    await second.invoke(
      { prompt: 'left-again' },
      execution(left, leftBudget, 'left-2', 'thread-left')
    )

    expect(leftBudget.usage.modelAttempts).toBe(2)
    expect(rightBudget.usage.modelAttempts).toBe(1)
    expect(seenRoots.filter((root) => root === left).length).toBeGreaterThan(0)
    expect(seenRoots.filter((root) => root === right).length).toBeGreaterThan(0)
    const rightBodies = bodies.filter((body) => JSON.stringify(body).includes('right-only'))
    expect(JSON.stringify(rightBodies)).not.toContain('left-only')
    const resumed = JSON.stringify(bodies.at(-1))
    expect(resumed).toContain('left-only')
  })

  it('检查点隔离运行上下文，新实例能读到已有状态', async () => {
    const fetcher = vi.fn(async () => Response.json(textMessage('saved')))
    const { factory, workspace } = await createFactory(fetcher)
    const checkpointer = new MemorySaver()
    const secret = 'sk-live-checkpoint-secret'
    const first = await factory.create(NoteAgent, { checkpointer })
    const context = {
      ...execution(workspace, budgetOf(), 'secret-run', 'thread-secret').context,
      secret
    }
    await first.invoke(
      { prompt: 'remember' },
      {
        ...execution(workspace, context.budget, 'secret-run', 'thread-secret'),
        context
      }
    )
    const tuple = await checkpointer.getTuple({ configurable: { thread_id: 'thread-secret' } })
    const serialized = JSON.stringify(tuple)
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain('stored-secret')
    const second = await factory.create(NoteAgent, { checkpointer })
    const callsBefore = fetcher.mock.calls.length
    await second.invoke(
      { prompt: 'again' },
      execution(workspace, budgetOf(), 'secret-run-2', 'thread-secret')
    )
    const resumedBody = JSON.parse(String(fetcher.mock.calls.at(-1)?.[1]?.body)) as {
      messages?: unknown[]
    }
    expect(fetcher.mock.calls.length).toBeGreaterThan(callsBefore)
    expect(JSON.stringify(resumedBody.messages)).toContain('remember')
  })

  it('复制运行上下文时保留修复模式', async () => {
    let seen: string | undefined
    const fetcher = vi.fn(async () => Response.json(textMessage('done')))
    const { factory, workspace } = await createFactory(fetcher)
    const agent = await factory.create(
      class extends EchoAgent {
        static readonly definition = {
          ...EchoAgent.definition,
          id: 'mode-agent',
          prompt: { agentId: 'mode-agent' },
          middleware: [
            createMiddleware({
              name: 'readMode',
              wrapModelCall: async (request, handler) => {
                seen = request.runtime.context.executionMode
                return handler(request)
              }
            })
          ]
        }
      }
    )
    const current = execution(workspace, budgetOf(), 'mode-run', 'mode-thread')
    await agent.invoke(
      { prompt: 'mode' },
      { ...current, context: { ...current.context, executionMode: 'repair' } }
    )
    expect(seen).toBe('repair')
  })
})

class EchoAgent implements Agent<{ prompt: string }, { text: string }> {
  static readonly definition: AgentDefinition = {
    id: 'echo-agent',
    prompt: { agentId: 'echo-agent' },
    createTools: () => [
      tool(
        async (input: { text: string }, runtime: { context?: AgentRunContext }) => {
          toolCalls += 1
          seenRoots.push(runtime.context?.workspace?.root ?? 'missing')
          return { echoed: input.text }
        },
        {
          name: 'echo',
          description: '回显文本',
          schema: z.object({ text: z.string() })
        }
      )
    ],
    middleware: [
      createMiddleware({
        name: 'marker',
        wrapModelCall: async (request, handler) => {
          const context = request.runtime.context as AgentRunContext | undefined
          seenRoots.push(context?.workspace?.root ?? 'missing')
          return handler(request)
        }
      })
    ],
    execution: { technicalRetryCount: 0 }
  }

  constructor(private readonly executor: ReactAgent) {}

  async invoke(input: { prompt: string }, execution: AgentExecution): Promise<{ text: string }> {
    try {
      const result = await this.executor.invoke(
        { messages: [{ role: 'user', content: input.prompt }] },
        invokeConfig(execution)
      )
      return { text: messageText(result.messages.at(-1)) }
    } catch (error) {
      throw normalizeAgentError(error)
    }
  }
}

class NoteAgent implements Agent<{ prompt: string }, { text: string }> {
  static readonly definition: AgentDefinition = {
    id: 'note-agent',
    prompt: { agentId: 'note-agent' },
    createTools: () => [
      tool(
        async (_input: { text: string }, runtime: { context?: AgentRunContext }) => {
          toolCalls += 1
          seenRoots.push(runtime.context?.workspace?.root ?? 'missing')
          return { noted: true }
        },
        {
          name: 'note',
          description: '记下文本',
          schema: z.object({ text: z.string() })
        }
      )
    ],
    middleware: [
      createMiddleware({
        name: 'noteMarker',
        wrapModelCall: async (request, handler) => {
          const context = request.runtime.context as AgentRunContext | undefined
          seenRoots.push(context?.workspace?.root ?? 'missing')
          return handler(request)
        }
      })
    ],
    execution: { technicalRetryCount: 0 }
  }

  constructor(private readonly executor: ReactAgent) {}

  async invoke(input: { prompt: string }, execution: AgentExecution): Promise<{ text: string }> {
    try {
      const result = await this.executor.invoke(
        { messages: [{ role: 'user', content: input.prompt }] },
        invokeConfig(execution)
      )
      return { text: messageText(result.messages.at(-1)) }
    } catch (error) {
      throw normalizeAgentError(error)
    }
  }
}

class StructuredAgent implements Agent<{ prompt: string }, { text: string; structured?: unknown }> {
  static readonly definition: AgentDefinition = {
    id: 'structured-agent',
    prompt: { agentId: 'structured-agent' },
    createTools: () => [
      tool(async () => ({ echoed: true }), {
        name: 'echo',
        description: '回显',
        schema: z.object({ text: z.string() })
      })
    ],
    responseFormat: toolStrategy(z.object({ answer: z.string() }), { handleError: false }),
    execution: { technicalRetryCount: 0 }
  }

  constructor(private readonly executor: ReactAgent) {}

  async invoke(
    input: { prompt: string },
    execution: AgentExecution
  ): Promise<{ text: string; structured?: unknown }> {
    try {
      const result = await this.executor.invoke(
        { messages: [{ role: 'user', content: input.prompt }] },
        invokeConfig(execution)
      )
      return { text: messageText(result.messages.at(-1)), structured: result.structuredResponse }
    } catch (error) {
      throw normalizeAgentError(error)
    }
  }
}

class UnsupportedAgent implements Agent<{ prompt: string }, { text: string }> {
  static readonly definition: AgentDefinition = {
    id: 'unsupported-agent',
    prompt: { agentId: 'unsupported-agent' },
    createTools: () => [],
    responseFormat: providerStrategy(z.object({ answer: z.string() })),
    execution: { technicalRetryCount: 0 }
  }

  constructor(private readonly executor: ReactAgent) {}

  async invoke(input: { prompt: string }, current: AgentExecution): Promise<{ text: string }> {
    try {
      const result = await this.executor.invoke(
        { messages: [{ role: 'user', content: input.prompt }] },
        invokeConfig(current)
      )
      return { text: messageText(result.messages.at(-1)) }
    } catch (error) {
      throw normalizeAgentError(error)
    }
  }
}

async function createFactory(fetcher: typeof fetch): Promise<{
  factory: LangChainAgentFactoryImpl
  workspace: string
}> {
  vi.stubEnv('OPENAI_API_KEY', 'ambient-openai-key')
  const prompts = await createRoot()
  await writePrompt(prompts, 'echo-agent', 'echo 提示')
  await writePrompt(prompts, 'note-agent', 'note 提示')
  await writePrompt(prompts, 'structured-agent', 'structured 提示')
  await writePrompt(prompts, 'unsupported-agent', 'unsupported 提示')
  await writePrompt(prompts, 'mode-agent', 'mode 提示')
  const workspace = await createRoot()
  return {
    workspace,
    factory: new LangChainAgentFactoryImpl(
      new LangChainModelFactory(async () => saved, streamingFetch(fetcher)),
      new FilePromptLoader(prompts)
    )
  }
}

function execution(
  root: string,
  budget: ExecutionBudget,
  executionId: string,
  threadId: string
): AgentExecution {
  return {
    identity: { executionId },
    scope: { threadId },
    context: {
      budget,
      workspace: { root, writable: true }
    }
  }
}

function budgetOf(): ExecutionBudget {
  return new ExecutionBudget({ modelAttempts: 8, toolCalls: 8, activeMs: 900000 })
}

function invokeConfig(current: AgentExecution): {
  context: AgentExecution['context']
  signal: AbortSignal | undefined
  configurable: { thread_id: string }
} {
  return {
    context: current.context,
    signal: current.signal,
    configurable: { thread_id: current.scope.threadId }
  }
}

function textMessage(content: string): Record<string, unknown> {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1,
    model: 'chosen',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
  }
}

function toolMessage(name: string, args: unknown): Record<string, unknown> {
  return {
    id: 'chatcmpl-tool',
    object: 'chat.completion',
    created: 1,
    model: 'chosen',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name, arguments: JSON.stringify(args) }
            }
          ]
        },
        finish_reason: 'tool_calls'
      }
    ],
    usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 }
  }
}

function forcedToolName(body: Record<string, unknown>): string | undefined {
  const choice = body.tool_choice
  if (!choice || typeof choice !== 'object' || !('function' in choice)) return undefined
  const definition = choice.function
  if (!definition || typeof definition !== 'object' || !('name' in definition)) return undefined
  return typeof definition.name === 'string' ? definition.name : undefined
}

function toolNames(body: Record<string, unknown>): string[] {
  const tools = body.tools as Array<{ function?: { name?: string } }> | undefined
  return (tools ?? []).flatMap((item) => (item.function?.name ? [item.function.name] : []))
}

function messageText(message: { content?: unknown } | undefined): string {
  if (!message) return ''
  return typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
}

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-'))
  roots.push(root)
  return root
}

async function writePrompt(root: string, agentId: string, body: string): Promise<void> {
  await mkdir(join(root, agentId), { recursive: true })
  await writeFile(join(root, agentId, 'system.md'), body)
}
