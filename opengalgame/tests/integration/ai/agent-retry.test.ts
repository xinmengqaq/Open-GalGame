import { streamingFetch } from './streamingFetch'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemorySaver } from '@langchain/langgraph-checkpoint'
import { tool, type ReactAgent } from 'langchain'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import type { Agent } from '@infrastructure/ai/agents/Agent'
import type { AgentDefinition } from '@infrastructure/ai/agents/AgentDefinition'
import type { AgentExecution } from '@infrastructure/ai/agents/AgentExecution'
import { ExecutionBudget } from '@infrastructure/ai/execution/ExecutionBudget'
import { LangChainAgentFactoryImpl } from '@infrastructure/ai/factories/LangChainAgentFactoryImpl'
import { normalizeAgentError } from '@infrastructure/ai/middleware/retryPolicy'
import { LangChainModelFactory } from '@infrastructure/ai/models/LangChainModelFactory'
import { FilePromptLoader } from '@infrastructure/ai/prompts/FilePromptLoader'
import type { ConnectionSettingsInfo } from '@domain/connections/models/ConnectionSettings'

const roots: string[] = []

const saved: ConnectionSettingsInfo = {
  providerId: 'openai-compatible',
  baseUrl: 'https://service.example/v1',
  model: 'chosen',
  contextWindow: 800,
  maxOutputTokens: 100,
  apiKey: 'stored-secret'
}

afterEach(async () => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Agent 技术重试、预算和摘要', () => {
  it('鉴权失败不重试，可重试故障按配置重试且不缩短 Retry-After', async () => {
    const auth = await scriptFactory([() => errorResponse(401, 'auth')])
    await expect(auth.agent.invoke({ prompt: 'auth' }, run(auth.workspace))).rejects.toThrow(
      '模型鉴权失败'
    )
    expect(auth.fetcher).toHaveBeenCalledTimes(1)

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const retried = await scriptFactory(
      [
        () => errorResponse(429, 'rate', { 'retry-after': '90' }),
        () => Response.json(textResponse('recovered'))
      ],
      { technicalRetryCount: 1 }
    )
    const pending = retried.agent.invoke({ prompt: 'retry' }, run(retried.workspace, 120000))
    await vi.advanceTimersByTimeAsync(89_999)
    expect(retried.fetcher).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).resolves.toMatchObject({ text: expect.stringContaining('recovered') })
    expect(retried.fetcher).toHaveBeenCalledTimes(2)
  })

  it('重试耗尽后失败，等待期间取消或剩余时间不足时不再请求模型', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const exhausted = await scriptFactory(
      [() => errorResponse(503, 'down'), () => errorResponse(503, 'down')],
      { technicalRetryCount: 1, technicalRetryDelayMs: 60000 }
    )
    const exhaustedRun = exhausted.agent.invoke({ prompt: 'down' }, run(exhausted.workspace))
    const exhaustedExpectation = expect(exhaustedRun).rejects.toThrow('模型执行失败')
    await vi.advanceTimersByTimeAsync(60_000)
    await exhaustedExpectation
    expect(exhausted.fetcher).toHaveBeenCalledTimes(2)

    const cancelled = await scriptFactory([() => errorResponse(503, 'down')], {
      technicalRetryCount: 1
    })
    const controller = new AbortController()
    const cancelRun = cancelled.agent.invoke(
      { prompt: 'cancel' },
      { ...run(cancelled.workspace), signal: controller.signal }
    )
    const cancelledExpectation = expect(cancelRun).rejects.toThrow('执行已取消')
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    await vi.advanceTimersByTimeAsync(0)
    await cancelledExpectation
    expect(cancelled.fetcher).toHaveBeenCalledTimes(1)

    const limited = await scriptFactory([() => errorResponse(503, 'down')], {
      technicalRetryCount: 1,
      activeLimitMs: 1000
    })
    await expect(
      limited.agent.invoke({ prompt: 'limit' }, run(limited.workspace, 1000))
    ).rejects.toThrow('活跃执行时间已用尽')
    expect(limited.fetcher).toHaveBeenCalledTimes(1)
  })

  it('无技术重试的一次模型失败只计一次错误', async () => {
    const once = await scriptFactory([() => errorResponse(503, 'down')], {
      technicalRetryCount: 0
    })
    const onceBudget = new ExecutionBudget({ modelAttempts: 4, toolCalls: 2, activeMs: 900000 })
    await expect(
      once.agent.invoke({ prompt: 'once' }, run(once.workspace, 900000, onceBudget))
    ).rejects.toThrow('模型执行失败')
    expect(once.fetcher).toHaveBeenCalledTimes(1)
    expect(onceBudget.usage.modelAttempts).toBe(1)
    expect(onceBudget.errorAttempts).toBe(1)

    const retried = await scriptFactory(
      [() => errorResponse(503, 'down'), () => errorResponse(503, 'down')],
      { technicalRetryCount: 1, technicalRetryDelayMs: 10000 }
    )
    const retriedBudget = new ExecutionBudget({ modelAttempts: 4, toolCalls: 2, activeMs: 900000 })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const pending = retried.agent.invoke(
      { prompt: 'twice' },
      run(retried.workspace, 900000, retriedBudget)
    )
    const expectation = expect(pending).rejects.toThrow('模型执行失败')
    await vi.advanceTimersByTimeAsync(10_000)
    await expectation
    expect(retried.fetcher).toHaveBeenCalledTimes(2)
    expect(retriedBudget.usage.modelAttempts).toBe(2)
    expect(retriedBudget.errorAttempts).toBe(2)
  })

  it('模型调用统计跨调用延续，但超过建议次数仍可正常响应', async () => {
    const fetcher = vi.fn(async () => Response.json(textResponse('once')))
    const { agent, workspace } = await createAgent(fetcher, {
      modelAttemptLimit: 1,
      technicalRetryCount: 0
    })
    const budget = new ExecutionBudget({ modelAttempts: 1, toolCalls: 2, activeMs: 900000 })
    await agent.invoke({ prompt: 'first' }, run(workspace, 900000, budget))
    expect(budget.usage.modelAttempts).toBe(1)
    await expect(
      agent.invoke({ prompt: 'second' }, run(workspace, 900000, budget))
    ).resolves.toBeDefined()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(budget.usage.modelAttempts).toBe(2)
  })

  it('摘要失败不覆盖旧消息，并且计入模型尝试', async () => {
    const prompt = '你'.repeat(2100)
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages?: Array<{ content?: unknown }> }
      const serialized = JSON.stringify(body)
      if (serialized.includes('Context Extraction Assistant')) {
        return errorResponse(503, 'summary down')
      }
      return Response.json(textResponse('kept'))
    })
    const { agent, workspace } = await createAgent(
      fetcher,
      {
        technicalRetryCount: 0,
        contextInputBudgetTokens: 5000,
        contextSafetyFraction: 0.1
      },
      { contextWindow: 8000, maxOutputTokens: 200 }
    )
    const budget = new ExecutionBudget({ modelAttempts: 8, toolCalls: 2, activeMs: 900000 })
    await agent.invoke({ prompt }, run(workspace, 900000, budget))
    const second = await agent.invoke({ prompt: '继续' }, run(workspace, 900000, budget))
    expect(second.text).toContain('kept')
    expect(second.transcript).not.toContain('Error generating summary')
    expect(budget.usage.modelAttempts).toBeGreaterThanOrEqual(3)
  })
})

class RetryAgent implements Agent<{ prompt: string }, { text: string; transcript: string }> {
  static readonly definition: AgentDefinition = {
    id: 'retry-agent',
    prompt: { agentId: 'retry-agent' },
    createTools: () => [
      tool(async () => 'ok', {
        name: 'echo',
        description: '回显',
        schema: z.object({ text: z.string() })
      })
    ]
  }

  constructor(private readonly executor: ReactAgent) {}

  async invoke(
    input: { prompt: string },
    current: AgentExecution
  ): Promise<{ text: string; transcript: string }> {
    try {
      const result = await this.executor.invoke(
        { messages: [{ role: 'user', content: input.prompt }] },
        {
          context: current.context,
          signal: current.signal,
          configurable: { thread_id: current.scope.threadId }
        }
      )
      const transcript = result.messages
        .map((message) =>
          typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
        )
        .join('\n')
      return { text: transcript, transcript }
    } catch (error) {
      throw normalizeAgentError(error)
    }
  }
}

async function scriptFactory(
  steps: Array<() => Response>,
  override?: AgentExecution['context'] extends never ? never : Record<string, number>
): Promise<{ agent: RetryAgent; fetcher: ReturnType<typeof vi.fn>; workspace: string }> {
  let index = 0
  const fetcher = vi.fn(async () => {
    const step = steps[Math.min(index, steps.length - 1)]
    index += 1
    if (!step) throw new Error('missing response')
    return step()
  })
  const created = await createAgent(fetcher, override)
  return { ...created, fetcher }
}

async function createAgent(
  fetcher: typeof fetch,
  override?: {
    technicalRetryCount?: number
    technicalRetryDelayMs?: number
    activeLimitMs?: number
    modelAttemptLimit?: number
    contextInputBudgetTokens?: number
    contextSafetyFraction?: number
  },
  model?: { contextWindow: number; maxOutputTokens: number }
): Promise<{ agent: RetryAgent; workspace: string }> {
  vi.stubEnv('OPENAI_API_KEY', 'ambient-openai-key')
  const prompts = await createRoot()
  await mkdir(join(prompts, 'retry-agent'))
  await writeFile(join(prompts, 'retry-agent', 'system.md'), 'retry 提示')
  const workspace = await createRoot()
  const factory = new LangChainAgentFactoryImpl(
    new LangChainModelFactory(async () => ({ ...saved, ...model }), streamingFetch(fetcher)),
    new FilePromptLoader(prompts)
  )
  const agent = await factory.create(RetryAgent, { override, checkpointer: new MemorySaver() })
  return { agent, workspace }
}

function run(workspace: string, activeMs = 900000, budget?: ExecutionBudget): AgentExecution {
  return {
    identity: { executionId: 'retry-run' },
    scope: { threadId: 'retry-thread' },
    context: {
      budget:
        budget ??
        new ExecutionBudget({
          modelAttempts: 8,
          toolCalls: 4,
          activeMs
        }),
      workspace: { root: workspace, writable: true }
    }
  }
}

function textResponse(content: string): Record<string, unknown> {
  return {
    id: 'chatcmpl-ok',
    object: 'chat.completion',
    created: 1,
    model: 'chosen',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }]
  }
}

function errorResponse(
  status: number,
  message: string,
  headers?: Record<string, string>
): Response {
  return Response.json(
    { error: { message, type: status === 401 ? 'authentication_error' : 'api_error' } },
    { status, headers }
  )
}

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'retry-'))
  roots.push(root)
  return root
}
