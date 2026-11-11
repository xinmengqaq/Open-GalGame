import { streamingFetch } from './streamingFetch'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HumanMessage } from '@langchain/core/messages'
import { createMiddleware, tool, toolStrategy, type ReactAgent } from 'langchain'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { Agent } from '@infrastructure/ai/agents/Agent'
import type { AgentDefinition } from '@infrastructure/ai/agents/AgentDefinition'
import type { AgentExecution } from '@infrastructure/ai/agents/AgentExecution'
import { ExecutionBudget } from '@infrastructure/ai/execution/ExecutionBudget'
import { FinalizeRequested } from '@infrastructure/ai/execution/executionErrors'
import { LangChainAgentFactoryImpl } from '@infrastructure/ai/factories/LangChainAgentFactoryImpl'
import { LangChainModelFactory } from '@infrastructure/ai/models/LangChainModelFactory'
import { FilePromptLoader } from '@infrastructure/ai/prompts/FilePromptLoader'
import type { ConnectionSettingsInfo } from '@domain/connections/models/ConnectionSettings'

const roots: string[] = []

const saved: ConnectionSettingsInfo = {
  providerId: 'openai-compatible',
  baseUrl: 'https://service.example/v1',
  model: 'chosen',
  contextWindow: 4000,
  maxOutputTokens: 200,
  apiKey: 'stored-secret'
}

afterEach(async () => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Agent 执行保护', () => {
  it('较宽松的调用方预算不能绕过工厂的时间和 token 上限', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']
    })
    const fetcher = vi.fn(async () => Response.json(textResponse('ok', 5)))
    const { agent, workspace } = await createAgent(fetcher, LooseAgent, {
      activeLimitMs: 20,
      cumulativeTokenLimit: 1,
      technicalRetryCount: 0,
      modelAttemptLimit: 4
    })
    const budget = new ExecutionBudget({ modelAttempts: 8, toolCalls: 8, activeMs: 900000 })

    await expect(agent.invoke({ prompt: 'ping' }, run(workspace, budget))).rejects.toThrow(
      '累计 token 已用尽'
    )

    expect(budget.usage.tokens).toBe(5)
    expect(budget.limits.activeMs).toBe(20)
    expect(budget.limits.tokens).toBe(1)
    expect(fetcher).toHaveBeenCalledTimes(1)
    await expect(agent.invoke({ prompt: 'again' }, run(workspace, budget))).rejects.toThrow(
      '累计 token 已用尽'
    )
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(budget.usage.tokens).toBe(5)
  })

  it('活跃时限会中止仍在进行的模型请求', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']
    })
    let aborted = false
    const fetcher = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal
          const fail = (): void => {
            aborted = true
            reject(signal?.reason ?? new Error('aborted'))
          }
          if (signal?.aborted) fail()
          else signal?.addEventListener('abort', fail, { once: true })
        })
    )
    const { agent, workspace } = await createAgent(fetcher, LooseAgent, {
      activeLimitMs: 20,
      technicalRetryCount: 0
    })
    const budget = new ExecutionBudget({ modelAttempts: 4, toolCalls: 2, activeMs: 900000 })
    const pending = agent.invoke({ prompt: 'wait' }, run(workspace, budget))
    const expectation = expect(pending).rejects.toThrow('活跃执行时间已用尽')

    await vi.advanceTimersByTimeAsync(0)
    expect(fetcher).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(20)

    await expectation
    expect(aborted).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('token 跨调用累计，超过上限后不再发起下一次请求', async () => {
    const fetcher = vi.fn(async () => Response.json(textResponse('ok', 5)))
    const { agent, workspace } = await createAgent(fetcher, LooseAgent, {
      cumulativeTokenLimit: 6,
      technicalRetryCount: 0,
      modelAttemptLimit: 4
    })
    const budget = new ExecutionBudget(
      { modelAttempts: 8, toolCalls: 2, activeMs: 900000, tokens: 100 },
      { tokens: 0 }
    )

    await agent.invoke({ prompt: 'first' }, run(workspace, budget))
    expect(budget.usage.tokens).toBe(5)
    await expect(agent.invoke({ prompt: 'second' }, run(workspace, budget))).rejects.toThrow(
      '累计 token 已用尽'
    )
    expect(budget.usage.tokens).toBe(10)
    expect(fetcher).toHaveBeenCalledTimes(2)
    await expect(agent.invoke({ prompt: 'third' }, run(workspace, budget))).rejects.toThrow(
      '累计 token 已用尽'
    )
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(budget.usage.tokens).toBe(10)
  })

  it('摘要和正式调用按各自的真实用量各计一次', async () => {
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages?: unknown }
      if (JSON.stringify(body).includes('Context Extraction Assistant')) {
        return Response.json(textResponse('摘要', 5))
      }
      return Response.json(textResponse('正式', 5))
    })
    const { agent, workspace } = await createAgent(
      fetcher,
      LooseAgent,
      {
        technicalRetryCount: 0,
        contextInputBudgetTokens: 5000,
        contextSafetyFraction: 0.1,
        cumulativeTokenLimit: 30,
        modelAttemptLimit: 6
      },
      { contextWindow: 8000, maxOutputTokens: 200 }
    )
    const budget = new ExecutionBudget({ modelAttempts: 8, toolCalls: 2, activeMs: 900000 })

    await agent.invoke(
      {
        prompt: '继续',
        history: [
          new HumanMessage({ content: '旧'.repeat(2100), id: 'old-1' }),
          new HumanMessage({ content: '后', id: 'old-2' }),
          new HumanMessage({ content: '后', id: 'old-3' })
        ]
      },
      run(workspace, budget)
    )

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(budget.usage.tokens).toBe(10)
  })

  it('摘要请求也不能超过有效输入预算', async () => {
    const bodies: string[] = []
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body))
      return Response.json(textResponse('ok', 1))
    })
    const { agent, workspace } = await createAgent(
      fetcher,
      LooseAgent,
      {
        technicalRetryCount: 0,
        contextInputBudgetTokens: 500,
        contextSafetyFraction: 0.1,
        modelAttemptLimit: 6
      },
      { contextWindow: 1000, maxOutputTokens: 100 }
    )

    await agent
      .invoke(
        {
          prompt: '继续',
          history: [
            new HumanMessage({ content: '旧'.repeat(400), id: 'old-1' }),
            new HumanMessage({ content: '旧'.repeat(400), id: 'old-2' }),
            new HumanMessage({ content: '旧'.repeat(400), id: 'old-3' })
          ]
        },
        run(workspace, new ExecutionBudget({ modelAttempts: 8, toolCalls: 2, activeMs: 900000 }))
      )
      .catch(() => undefined)

    expect(bodies.length).toBeGreaterThan(0)
    for (const body of bodies) {
      expect(estimateRequestTokens(body)).toBeLessThanOrEqual(500)
    }
  })

  it('工具仍能读到原生状态、调用标识和配置', async () => {
    const seen: {
      state?: { marker?: string }
      toolCallId?: string
      config?: unknown
    } = {}
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages?: Array<{ role?: string }> }
      if (body.messages?.some((message) => message.role === 'tool')) {
        return Response.json(textResponse('完成', 1))
      }
      return Response.json(toolResponse('inspect', { text: 'hi' }, 1))
    })
    const { agent, workspace } = await createAgent(fetcher, InspectAgent, {
      technicalRetryCount: 0,
      modelAttemptLimit: 3,
      toolCallLimit: 1
    })
    inspectSeen = seen

    await agent.invoke(
      { prompt: '看运行时', marker: 'keep-me' },
      run(workspace, new ExecutionBudget({ modelAttempts: 4, toolCalls: 2, activeMs: 900000 }))
    )

    expect(seen.state?.marker).toBe('keep-me')
    expect(seen.toolCallId).toEqual(expect.any(String))
    expect(seen.toolCallId?.length).toBeGreaterThan(0)
    expect(seen.config).toEqual(expect.any(Object))
  })

  it('摘要保护不改写调用方上下文，冻结对象也能带必需消息', async () => {
    const fetcher = vi.fn(async () => Response.json(textResponse('ok', 1)))
    const { agent, workspace } = await createAgent(fetcher, LooseAgent, {
      technicalRetryCount: 0,
      modelAttemptLimit: 2
    })
    const mutable = {
      ...run(workspace, new ExecutionBudget({ modelAttempts: 4, toolCalls: 1, activeMs: 900000 }))
        .context,
      keep: { messages: 4 }
    }
    await agent.invoke({ prompt: '普通' }, { ...run(workspace, mutable.budget), context: mutable })
    expect(mutable.keep).toEqual({ messages: 4 })

    const frozenBudget = new ExecutionBudget({ modelAttempts: 4, toolCalls: 1, activeMs: 900000 })
    const frozen = Object.freeze({
      budget: frozenBudget,
      workspace: { root: workspace, writable: true },
      keep: { messages: 2 },
      requiredMessageIds: ['must-keep']
    })
    await expect(
      agent.invoke(
        {
          prompt: '现在',
          history: [
            new HumanMessage({
              content: '必须保留的原文标记',
              id: 'must-keep',
              additional_kwargs: { required: true }
            })
          ]
        },
        {
          identity: { executionId: 'frozen' },
          scope: { threadId: 'frozen-thread' },
          context: frozen
        }
      )
    ).resolves.toEqual(expect.objectContaining({ text: expect.any(String) }))
    expect(frozen.keep).toEqual({ messages: 2 })
  })

  it('结构化输出按模型响应记录 token，而不是记成 0', async () => {
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      const name = toolNames(body).find((item) => item !== 'echo') ?? 'emit'
      return Response.json(toolResponse(name, { answer: 'ok' }, 5))
    })
    const { agent, workspace } = await createAgent(fetcher, StructuredAgent, {
      technicalRetryCount: 0,
      cumulativeTokenLimit: 20,
      modelAttemptLimit: 3
    })
    const budget = new ExecutionBudget({ modelAttempts: 4, toolCalls: 2, activeMs: 900000 })

    const result = await agent.invoke({ prompt: '结构' }, run(workspace, budget))

    expect(result.structured).toMatchObject({ answer: 'ok' })
    expect(budget.usage.tokens).toBe(5)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('必需原文在摘要前保留；放不下时直接失败且不请求模型', async () => {
    const bodies: string[] = []
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const serialized = String(init?.body)
      bodies.push(serialized)
      if (serialized.includes('Context Extraction Assistant')) {
        return Response.json(textResponse('这是摘要', 1))
      }
      return Response.json(textResponse('done', 1))
    })
    const kept = await createAgent(
      fetcher,
      LooseAgent,
      {
        technicalRetryCount: 0,
        contextInputBudgetTokens: 800,
        contextSafetyFraction: 0.1,
        modelAttemptLimit: 6
      },
      { contextWindow: 4000, maxOutputTokens: 100 }
    )
    await kept.agent.invoke(
      {
        prompt: '现在',
        history: [
          new HumanMessage({ content: '旧'.repeat(500), id: 'filler' }),
          new HumanMessage({
            content: '必须保留的原文标记',
            id: 'must-keep',
            additional_kwargs: { required: true }
          }),
          new HumanMessage({ content: '后来一', id: 'later-1' }),
          new HumanMessage({ content: '后来二', id: 'later-2' })
        ]
      },
      run(kept.workspace, new ExecutionBudget({ modelAttempts: 8, toolCalls: 2, activeMs: 900000 }))
    )
    const formal = bodies.filter((body) => !body.includes('Context Extraction Assistant'))
    expect(formal.some((body) => body.includes('必须保留的原文标记'))).toBe(true)

    const blockedFetcher = vi.fn(async () => Response.json(textResponse('no', 1)))
    const blocked = await createAgent(
      blockedFetcher,
      LooseAgent,
      {
        technicalRetryCount: 0,
        contextInputBudgetTokens: 40,
        contextSafetyFraction: 0.1,
        modelAttemptLimit: 4
      },
      { contextWindow: 400, maxOutputTokens: 20 }
    )
    await expect(
      blocked.agent.invoke(
        {
          prompt: '现在',
          history: [
            new HumanMessage({
              content: '必'.repeat(200),
              id: 'too-big',
              additional_kwargs: { required: true }
            })
          ]
        },
        run(
          blocked.workspace,
          new ExecutionBudget({ modelAttempts: 4, toolCalls: 1, activeMs: 900000 })
        )
      )
    ).rejects.toThrow('必需内容超过上下文预算')
    expect(blockedFetcher).not.toHaveBeenCalled()
  })

  it('附加中间件注入的系统提示词仍受输入预算限制', async () => {
    const fetcher = vi.fn(async () => Response.json(textResponse('ok', 1)))
    const { agent, workspace } = await createAgent(
      fetcher,
      DynamicPromptAgent,
      {
        technicalRetryCount: 0,
        contextInputBudgetTokens: 800,
        contextSafetyFraction: 0.1,
        modelAttemptLimit: 2
      },
      { contextWindow: 4000, maxOutputTokens: 50 }
    )

    await expect(
      agent.invoke(
        { prompt: '动态' },
        run(workspace, new ExecutionBudget({ modelAttempts: 4, toolCalls: 1, activeMs: 900000 }))
      )
    ).rejects.toThrow('必需内容超过上下文预算')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('工具超时和用户取消进入 runtime.signal，并行调用互不清除', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    let slowSignal: AbortSignal | undefined
    let fastSignal: AbortSignal | undefined
    let slowFinished = false
    const fetcher = vi.fn(async () => Response.json(parallelToolsResponse()))
    const { agent, workspace } = await createAgent(
      fetcher,
      ParallelAgent,
      { toolTimeoutMs: 20, technicalRetryCount: 0, modelAttemptLimit: 2, toolCallLimit: 2 },
      undefined,
      {
        onFast(signal) {
          fastSignal = signal
        },
        onSlow(signal) {
          slowSignal = signal
        },
        onSlowFinish() {
          slowFinished = true
        }
      }
    )
    const pending = agent.invoke(
      { prompt: '并行' },
      run(workspace, new ExecutionBudget({ modelAttempts: 4, toolCalls: 4, activeMs: 900000 }))
    )
    const expectation = expect(pending).rejects.toThrow('单次调用超时')

    await vi.advanceTimersByTimeAsync(0)
    expect(slowSignal).toBeDefined()
    expect(fastSignal).toBeDefined()
    expect(slowSignal).not.toBe(fastSignal)
    expect(slowSignal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(20)

    await expectation
    expect(slowSignal?.aborted).toBe(true)
    expect(slowFinished).toBe(false)
  })

  it('两轮模型加一次工具不会提前触发递归限制，附加中间件也不使限制失效', async () => {
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages?: Array<{ role?: string }> }
      if (body.messages?.some((message) => message.role === 'tool')) {
        return Response.json(textResponse('完成', 1))
      }
      return Response.json(toolResponse('echo', { text: 'hi' }, 1))
    })
    const budget = new ExecutionBudget({ modelAttempts: 2, toolCalls: 1, activeMs: 900000 })
    const plain = await createAgent(fetcher, ToolAgent, {
      modelAttemptLimit: 2,
      toolCallLimit: 1,
      technicalRetryCount: 0
    })
    await expect(
      plain.agent.invoke({ prompt: '走工具' }, run(plain.workspace, budget))
    ).resolves.toMatchObject({
      text: expect.stringContaining('完成')
    })

    const extraFetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages?: Array<{ role?: string }> }
      if (body.messages?.some((message) => message.role === 'tool')) {
        return Response.json(textResponse('完成', 1))
      }
      return Response.json(toolResponse('echo', { text: 'hi' }, 1))
    })
    const extra = await createAgent(extraFetcher, ToolAgentWithMiddleware, {
      modelAttemptLimit: 2,
      toolCallLimit: 1,
      technicalRetryCount: 0
    })
    await expect(
      extra.agent.invoke(
        { prompt: '再走' },
        run(
          extra.workspace,
          new ExecutionBudget({ modelAttempts: 2, toolCalls: 1, activeMs: 900000 })
        )
      )
    ).resolves.toMatchObject({ text: expect.stringContaining('完成') })
  })

  it('正常工具批次不因建议工具总次数而截断', async () => {
    const ran: string[] = []
    const fetcher = vi.fn(async () => Response.json(multiToolResponse(['first', 'second'])))
    const { agent, workspace } = await createAgent(
      fetcher,
      BatchToolAgent,
      { technicalRetryCount: 0, modelAttemptLimit: 3, toolCallLimit: 1 },
      undefined,
      { onTool: (name) => ran.push(name) }
    )
    const budget = new ExecutionBudget({ modelAttempts: 4, toolCalls: 1, activeMs: 900000 })

    await expect(agent.invoke({ prompt: '批量' }, run(workspace, budget))).resolves.toMatchObject({
      text: expect.stringContaining('second-done')
    })

    expect(ran).toEqual(['first', 'second'])
    expect(budget.usage.toolCalls).toBe(2)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('同一批六个已见结果只结算一轮，整批返回后仍进入下一次模型调用', async () => {
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages?: Array<{ role?: string }> }
      const seen = body.messages?.filter((message) => message.role === 'tool').length ?? 0
      if (seen === 0) return Response.json(toolResponse('echo', { text: 'same' }, 1, 'seed_1'))
      if (seen === 1) return Response.json(sameToolBatchResponse('echo', { text: 'same' }, 6))
      return Response.json(textResponse('完成', 1))
    })
    const { agent, workspace } = await createAgent(fetcher, ToolAgent, { technicalRetryCount: 0 })
    const budget = new ExecutionBudget({ modelAttempts: 5, toolCalls: 10, activeMs: 900000 })

    await expect(
      agent.invoke({ prompt: '同批重复' }, run(workspace, budget))
    ).resolves.toMatchObject({ text: expect.stringContaining('完成') })

    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(budget.usage.modelAttempts).toBe(3)
    expect(budget.usage.toolCalls).toBe(7)
    expect(budget.errorAttempts).toBe(0)
  })

  it('连续读取不同内容不消耗错误预算，相同参数的重复调用才进入错误保护', async () => {
    let round = 0
    const different = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages?: Array<{ role?: string }> }
      const seen = body.messages?.filter((message) => message.role === 'tool').length ?? 0
      if (seen >= 10) return Response.json(textResponse('完成', 1))
      round += 1
      return Response.json(toolResponse('echo', { text: `页${seen}` }, 1, `call_${round}`))
    })
    const continued = await createAgent(different, ToolAgent, { technicalRetryCount: 0 })
    const continuedBudget = new ExecutionBudget({
      modelAttempts: 4,
      toolCalls: 4,
      activeMs: 900000
    })
    await expect(
      continued.agent.invoke({ prompt: '分页' }, run(continued.workspace, continuedBudget))
    ).resolves.toMatchObject({ text: expect.stringContaining('完成') })
    expect(continuedBudget.errorAttempts).toBe(0)
    expect(continuedBudget.usage.toolCalls).toBe(10)

    const revisit = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages?: Array<{ role?: string }> }
      const seen = body.messages?.filter((message) => message.role === 'tool').length ?? 0
      if (seen >= 3) return Response.json(textResponse('回读完成', 1))
      const offset = seen === 1 ? 100 : 0
      return Response.json(toolResponse('echo', { text: `页${offset}` }, 1, `revisit_${seen}`))
    })
    const revisited = await createAgent(revisit, ToolAgent, { technicalRetryCount: 0 })
    const revisitBudget = new ExecutionBudget({
      modelAttempts: 4,
      toolCalls: 4,
      activeMs: 900000
    })
    await expect(
      revisited.agent.invoke({ prompt: '回读' }, run(revisited.workspace, revisitBudget))
    ).resolves.toMatchObject({ text: expect.stringContaining('回读完成') })
    expect(revisitBudget.errorAttempts).toBe(0)
    expect(revisitBudget.usage.toolCalls).toBe(3)

    const same = vi.fn(async () => {
      round += 1
      return Response.json(toolResponse('echo', { text: 'same' }, 1, `same_${round}`))
    })
    const repeated = await createAgent(same, ToolAgent, { technicalRetryCount: 0 })
    const repeatedBudget = new ExecutionBudget({
      modelAttempts: 4,
      toolCalls: 4,
      activeMs: 900000
    })
    const repeatedError = await repeated.agent
      .invoke({ prompt: '重复' }, run(repeated.workspace, repeatedBudget))
      .catch((caught: unknown) => caught)
    expect(repeatedError).toBeInstanceOf(FinalizeRequested)
    expect(repeatedError).toMatchObject({ message: '需要收尾提交结构化结果' })
    expect(repeatedBudget.errorAttempts).toBe(0)
    expect(same.mock.calls.length).toBeLessThan(30)
    expect(repeatedBudget.usage.modelAttempts).toBe(same.mock.calls.length)
  })

  it('交替重复且结果不变的计划计入错误预算，分页式回读不拦截', async () => {
    const ran: string[] = []
    let round = 0
    const fetcher = vi.fn(async () => {
      round += 1
      if (round > 12) return Response.json(textResponse('停止', 1))
      const text = round % 2 === 0 ? 'dir' : 'file'
      return Response.json(toolResponse('echo', { text }, 1, `alt_${round}`))
    })
    const alternating = await createAgent(
      fetcher,
      ToolAgent,
      { technicalRetryCount: 0 },
      undefined,
      { onTool: () => ran.push('echo') }
    )
    const budget = new ExecutionBudget({ modelAttempts: 4, toolCalls: 4, activeMs: 900000 })

    const alternatingError = await alternating.agent
      .invoke({ prompt: '交替' }, run(alternating.workspace, budget))
      .catch((caught: unknown) => caught)
    expect(alternatingError).toBeInstanceOf(FinalizeRequested)
    expect(alternatingError).toMatchObject({ message: '需要收尾提交结构化结果' })

    expect(ran.length).toBeGreaterThan(3)
    expect(ran.length).toBeLessThan(30)
    expect(budget.errorAttempts).toBe(0)
    expect(budget.usage.toolCalls).toBe(ran.length)
  })

  it('提示后读取新内容继续，同一结果重复到阈值才停止且不占错误预算', async () => {
    let round = 0
    const continued = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages?: unknown[] }
      const text = JSON.stringify(body.messages ?? [])
      round += 1
      if (text.includes('[执行约束]')) {
        return Response.json(textResponse('已收到提醒', 2))
      }
      return Response.json(toolResponse('readTextRange', { path: 'same.txt' }, 2, `same_${round}`))
    })
    const continuedRun = await createAgent(continued, ReadWriteAgent, { technicalRetryCount: 0 })
    const continuedBudget = new ExecutionBudget({
      modelAttempts: 20,
      toolCalls: 20,
      activeMs: 900000
    })
    await expect(
      continuedRun.agent.invoke({ prompt: '读新内容' }, run(continuedRun.workspace, continuedBudget))
    ).resolves.toMatchObject({ text: expect.stringContaining('已收到提醒') })
    expect(continued.mock.calls.some((call) => String(call[1]?.body).includes('[执行约束]'))).toBe(
      true
    )
    expect(continuedBudget.errorAttempts).toBe(0)

    let repeatedRound = 0
    const repeated = vi.fn(async () => {
      repeatedRound += 1
      return Response.json(
        toolResponse('readTextRange', { path: 'same.txt' }, 2, `same_${repeatedRound}`)
      )
    })
    const repeatedRun = await createAgent(repeated, ReadWriteAgent, { technicalRetryCount: 0 })
    const repeatedBudget = new ExecutionBudget({
      modelAttempts: 20,
      toolCalls: 20,
      activeMs: 900000
    })
    const error = await repeatedRun.agent
      .invoke({ prompt: '重复读取' }, run(repeatedRun.workspace, repeatedBudget))
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(FinalizeRequested)
    expect(error).toMatchObject({ message: '需要收尾提交结构化结果' })
    expect(repeatedBudget.errorAttempts).toBe(0)
    expect(repeated.mock.calls.length).toBeLessThan(12)
  })

  it('提示后写出候选会清空无进展并继续完成', async () => {
    let nudged = false
    let wrote = false
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages?: unknown[] }
      const text = JSON.stringify(body.messages ?? [])
      if (!nudged && text.includes('[执行约束]')) nudged = true
      if (nudged && !wrote) {
        wrote = true
        return Response.json(toolResponse('writeText', { path: 'scene.txt' }, 2, 'write_1'))
      }
      if (wrote) return Response.json(textResponse('完成', 2))
      return Response.json(
        toolResponse('readTextRange', { path: 'same.txt' }, 2, `read_${fetcher.mock.calls.length}`)
      )
    })
    const { agent, workspace } = await createAgent(fetcher, ReadWriteAgent, {
      technicalRetryCount: 0
    })
    const budget = new ExecutionBudget({ modelAttempts: 20, toolCalls: 20, activeMs: 900000 })
    await expect(agent.invoke({ prompt: '先读后写' }, run(workspace, budget))).resolves.toMatchObject(
      {
        text: expect.stringContaining('完成')
      }
    )
    expect(nudged).toBe(true)
    expect(wrote).toBe(true)
    expect(budget.errorAttempts).toBe(0)
  })

  it('写出后自动读改两轮会提示提交，第 3 轮仍无提交时停止且不占错误预算', async () => {
    const bodies: string[] = []
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const raw = String(init?.body)
      bodies.push(raw)
      const body = JSON.parse(raw) as { messages?: Array<{ role?: string }> }
      const tools = body.messages?.filter((message) => message.role === 'tool').length ?? 0
      if (tools === 0) {
        return Response.json(
          toolResponse('writeText', { path: 'game/scene/start.txt', content: 'one' }, 2, 'write_1')
        )
      }
      if (raw.includes('候选已经写出')) {
        return Response.json(
          toolResponse('readTextRange', { path: 'game/scene/start.txt' }, 2, 'final_read')
        )
      }
      return Response.json(
        toolResponse(
          'replaceText',
          { path: 'game/scene/start.txt', oldText: 'one', newText: 'two', expectedMatches: 1 },
          2,
          `edit_${tools}`
        )
      )
    })
    const { agent, workspace } = await createAgent(fetcher, StructuredReadWriteAgent, {
      technicalRetryCount: 0
    })
    const budget = new ExecutionBudget({ modelAttempts: 20, toolCalls: 20, activeMs: 900000 })
    const error = await agent
      .invoke({ prompt: '写后自检' }, writableRun(workspace, budget))
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(FinalizeRequested)
    expect(error).toMatchObject({
      causeKind: 'postWriteNoSubmission',
      message: '需要收尾提交结构化结果'
    })
    expect(bodies.some((body) => body.includes('候选已经写出'))).toBe(true)
    expect(budget.errorAttempts).toBe(0)
    expect(fetcher.mock.calls.length).toBeLessThan(8)
  })

  it('非法结构化参数不能结束写后阶段，重试仍有界', async () => {
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        messages?: Array<{ role?: string }>
        tools?: Array<{ function?: { name?: string } }>
      }
      const tools = body.messages?.filter((message) => message.role === 'tool').length ?? 0
      const structured = body.tools?.find(
        (item) =>
          item.function?.name &&
          !['readTextRange', 'writeText', 'replaceText', 'read_file', 'listDirectory'].includes(
            item.function.name
          )
      )?.function?.name
      if (!structured) throw new Error('请求没有结构化工具')
      if (tools === 0) {
        return Response.json(
          toolResponse('writeText', { path: 'game/scene/start.txt', content: 'one' }, 2, 'write_1')
        )
      }
      return Response.json(toolResponse(structured, { answer: 1 }, 2, `bad_${tools}`))
    })
    const { agent, workspace } = await createAgent(fetcher, StructuredReadWriteAgent, {
      technicalRetryCount: 0
    })
    const budget = new ExecutionBudget({ modelAttempts: 20, toolCalls: 20, activeMs: 900000 })
    await expect(
      agent.invoke({ prompt: '非法提交' }, writableRun(workspace, budget))
    ).rejects.toThrow(FinalizeRequested)
    expect(budget.errorAttempts).toBe(0)
    expect(fetcher.mock.calls.length).toBeLessThan(8)
  })

  it('执行器边界把鉴权失败转成项目错误，智能体不再自行捕获', async () => {
    const fetcher = vi.fn(async () =>
      Response.json(
        { error: { message: 'expired', type: 'authentication_error' } },
        { status: 401 }
      )
    )
    const { agent, workspace } = await createAgent(fetcher, LooseAgent, {
      technicalRetryCount: 0
    })

    const error = await agent
      .invoke(
        { prompt: 'auth' },
        run(workspace, new ExecutionBudget({ modelAttempts: 2, toolCalls: 1, activeMs: 900000 }))
      )
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(AppException)
    expect(error).toMatchObject({ code: ErrorCodes.forbidden, message: '模型鉴权失败' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})

interface ToolHooks {
  onFast?: (signal: AbortSignal | undefined) => void
  onSlow?: (signal: AbortSignal | undefined) => void
  onSlowFinish?: () => void
  onTool?: (name: string) => void
}

let inspectSeen: {
  state?: { marker?: string }
  toolCallId?: string
  config?: unknown
} = {}

let toolHooks: ToolHooks = {}

class LooseAgent implements Agent<{ prompt: string; history?: HumanMessage[] }, { text: string }> {
  static readonly definition: AgentDefinition = {
    id: 'loose-agent',
    prompt: { agentId: 'loose-agent' },
    createTools: () => [],
    execution: { technicalRetryCount: 0 }
  }

  constructor(private readonly executor: ReactAgent) {}

  async invoke(
    input: { prompt: string; history?: HumanMessage[] },
    current: AgentExecution
  ): Promise<{ text: string }> {
    const result = await this.executor.invoke(
      { messages: [...(input.history ?? []), { role: 'user', content: input.prompt }] },
      invokeConfig(current)
    )
    return { text: messageText(result.messages.at(-1)) }
  }
}

class StructuredAgent implements Agent<{ prompt: string }, { text: string; structured?: unknown }> {
  static readonly definition: AgentDefinition = {
    id: 'structured-guard',
    prompt: { agentId: 'structured-guard' },
    createTools: () => [],
    responseFormat: toolStrategy(z.object({ answer: z.string() })),
    execution: { technicalRetryCount: 0 }
  }

  constructor(private readonly executor: ReactAgent) {}

  async invoke(
    input: { prompt: string },
    current: AgentExecution
  ): Promise<{ text: string; structured?: unknown }> {
    const result = await this.executor.invoke(
      { messages: [{ role: 'user', content: input.prompt }] },
      invokeConfig(current)
    )
    return { text: messageText(result.messages.at(-1)), structured: result.structuredResponse }
  }
}

class DynamicPromptAgent implements Agent<{ prompt: string }, { text: string }> {
  static readonly definition: AgentDefinition = {
    id: 'dynamic-prompt',
    prompt: { agentId: 'dynamic-prompt' },
    createTools: () => [],
    middleware: [
      createMiddleware({
        name: 'injectPrompt',
        wrapModelCall: (request, handler) =>
          handler({ ...request, systemPrompt: '增'.repeat(1200) })
      })
    ],
    execution: { technicalRetryCount: 0 }
  }

  constructor(private readonly executor: ReactAgent) {}

  async invoke(input: { prompt: string }, current: AgentExecution): Promise<{ text: string }> {
    const result = await this.executor.invoke(
      { messages: [{ role: 'user', content: input.prompt }] },
      invokeConfig(current)
    )
    return { text: messageText(result.messages.at(-1)) }
  }
}

class ParallelAgent implements Agent<{ prompt: string }, { text: string }> {
  static readonly definition: AgentDefinition = {
    id: 'parallel-agent',
    prompt: { agentId: 'parallel-agent' },
    createTools: () => [
      tool(
        async (_input: Record<string, never>, runtime: { signal?: AbortSignal }) => {
          toolHooks.onFast?.(runtime.signal)
          return 'fast'
        },
        { name: 'fast', description: '快工具', schema: z.object({}).strict() }
      ),
      tool(
        async (_input: Record<string, never>, runtime: { signal?: AbortSignal }) => {
          toolHooks.onSlow?.(runtime.signal)
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              toolHooks.onSlowFinish?.()
              resolve()
            }, 150)
            runtime.signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(timer)
                reject(runtime.signal?.reason ?? new Error('aborted'))
              },
              { once: true }
            )
          })
          return 'slow'
        },
        { name: 'slow', description: '慢工具', schema: z.object({}).strict() }
      )
    ],
    execution: { technicalRetryCount: 0 }
  }

  constructor(private readonly executor: ReactAgent) {}

  async invoke(input: { prompt: string }, current: AgentExecution): Promise<{ text: string }> {
    const result = await this.executor.invoke(
      { messages: [{ role: 'user', content: input.prompt }] },
      invokeConfig(current)
    )
    return { text: messageText(result.messages.at(-1)) }
  }
}

class BatchToolAgent implements Agent<{ prompt: string }, { text: string }> {
  static readonly definition: AgentDefinition = {
    id: 'batch-tools',
    prompt: { agentId: 'batch-tools' },
    createTools: () => [
      tool(
        async () => {
          toolHooks.onTool?.('first')
          return 'first-done'
        },
        { name: 'first', description: '批内第一个工具', schema: z.object({}).strict() }
      ),
      tool(
        async () => {
          toolHooks.onTool?.('second')
          return 'second-done'
        },
        { name: 'second', description: '批内第二个工具', schema: z.object({}).strict() }
      )
    ],
    execution: { technicalRetryCount: 0 }
  }

  constructor(private readonly executor: ReactAgent) {}

  async invoke(input: { prompt: string }, current: AgentExecution): Promise<{ text: string }> {
    const result = await this.executor.invoke(
      { messages: [{ role: 'user', content: input.prompt }] },
      invokeConfig(current)
    )
    return { text: messageText(result.messages.at(-1)) }
  }
}

class InspectAgent implements Agent<{ prompt: string; marker: string }, { text: string }> {
  static readonly definition: AgentDefinition = {
    id: 'inspect-agent',
    prompt: { agentId: 'inspect-agent' },
    createTools: () => [
      tool(
        async (
          _input: { text: string },
          runtime: { state?: { marker?: string }; toolCallId?: string; config?: unknown }
        ) => {
          inspectSeen.state = runtime.state
          inspectSeen.toolCallId = runtime.toolCallId
          inspectSeen.config = runtime.config
          return 'seen'
        },
        {
          name: 'inspect',
          description: '查看运行时',
          schema: z.object({ text: z.string() })
        }
      )
    ],
    stateSchema: z.object({
      marker: z.string().default('')
    }),
    execution: { technicalRetryCount: 0 }
  }

  constructor(private readonly executor: ReactAgent) {}

  async invoke(
    input: { prompt: string; marker: string },
    current: AgentExecution
  ): Promise<{ text: string }> {
    const result = await this.executor.invoke(
      { messages: [{ role: 'user', content: input.prompt }], marker: input.marker },
      invokeConfig(current)
    )
    return { text: messageText(result.messages.at(-1)) }
  }
}

class ToolAgent implements Agent<{ prompt: string }, { text: string }> {
  static readonly definition: AgentDefinition = {
    id: 'tool-loop',
    prompt: { agentId: 'tool-loop' },
    createTools: () => [
      tool(
        async () => {
          toolHooks.onTool?.('echo')
          return 'echoed'
        },
        {
          name: 'echo',
          description: '回显',
          schema: z.object({ text: z.string() })
        }
      )
    ],
    execution: { technicalRetryCount: 0 }
  }

  constructor(private readonly executor: ReactAgent) {}

  async invoke(input: { prompt: string }, current: AgentExecution): Promise<{ text: string }> {
    const result = await this.executor.invoke(
      { messages: [{ role: 'user', content: input.prompt }] },
      invokeConfig(current)
    )
    return { text: messageText(result.messages.at(-1)) }
  }
}

class ReadWriteAgent implements Agent<{ prompt: string }, { text: string }> {
  static readonly definition: AgentDefinition = {
    id: 'read-write',
    prompt: { agentId: 'read-write' },
    createTools: () => [
      tool(async () => 'same-body', {
        name: 'readTextRange',
        description: '读取',
        schema: z.object({ path: z.string() })
      }),
      tool(async () => 'written', {
        name: 'writeText',
        description: '写入',
        schema: z.object({ path: z.string(), content: z.string().optional() })
      }),
      tool(async () => JSON.stringify({ path: 'game/scene/start.txt', replaced: 1 }), {
        name: 'replaceText',
        description: '替换',
        schema: z.object({
          path: z.string(),
          oldText: z.string(),
          newText: z.string(),
          expectedMatches: z.number()
        })
      })
    ],
    execution: { technicalRetryCount: 0 }
  }

  constructor(private readonly executor: ReactAgent) {}

  async invoke(input: { prompt: string }, current: AgentExecution): Promise<{ text: string }> {
    const result = await this.executor.invoke(
      { messages: [{ role: 'user', content: input.prompt }] },
      invokeConfig(current)
    )
    return { text: messageText(result.messages.at(-1)) }
  }
}

class StructuredReadWriteAgent implements Agent<{ prompt: string }, { text: string }> {
  static readonly definition: AgentDefinition = {
    id: 'structured-read-write',
    prompt: { agentId: 'structured-read-write' },
    createTools: ReadWriteAgent.definition.createTools,
    responseFormat: toolStrategy(z.object({ answer: z.string() })),
    execution: { technicalRetryCount: 0 }
  }

  constructor(private readonly executor: ReactAgent) {}

  async invoke(input: { prompt: string }, current: AgentExecution): Promise<{ text: string }> {
    const result = await this.executor.invoke(
      { messages: [{ role: 'user', content: input.prompt }] },
      invokeConfig(current)
    )
    return { text: messageText(result.messages.at(-1)) }
  }
}

class ToolAgentWithMiddleware implements Agent<{ prompt: string }, { text: string }> {
  static readonly definition: AgentDefinition = {
    id: 'tool-loop-extra',
    prompt: { agentId: 'tool-loop-extra' },
    createTools: () => [
      tool(async () => 'echoed', {
        name: 'echo',
        description: '回显',
        schema: z.object({ text: z.string() })
      })
    ],
    middleware: [
      createMiddleware({
        name: 'extraBefore',
        beforeModel: () => undefined
      })
    ],
    execution: { technicalRetryCount: 0 }
  }

  constructor(private readonly executor: ReactAgent) {}

  async invoke(input: { prompt: string }, current: AgentExecution): Promise<{ text: string }> {
    const result = await this.executor.invoke(
      { messages: [{ role: 'user', content: input.prompt }] },
      invokeConfig(current)
    )
    return { text: messageText(result.messages.at(-1)) }
  }
}

async function createAgent<T extends AgentImplementationLike>(
  fetcher: typeof fetch,
  implementation: T,
  override: Record<string, number> | undefined,
  model?: { contextWindow: number; maxOutputTokens: number },
  hooks?: ToolHooks
): Promise<{ agent: InstanceType<T>; workspace: string }> {
  toolHooks = hooks ?? {}
  vi.stubEnv('OPENAI_API_KEY', 'ambient-openai-key')
  const prompts = await createRoot()
  const ids = [
    'loose-agent',
    'structured-guard',
    'dynamic-prompt',
    'parallel-agent',
    'batch-tools',
    'inspect-agent',
    'tool-loop',
    'tool-loop-extra',
    'read-write',
    'structured-read-write'
  ]
  for (const id of ids) {
    await mkdir(join(prompts, id), { recursive: true })
    await writeFile(join(prompts, id, 'system.md'), `${id} 提示`)
  }
  const workspace = await createRoot()
  const settings = model ? { ...saved, ...model } : saved
  const factory = new LangChainAgentFactoryImpl(
    new LangChainModelFactory(async () => settings, streamingFetch(fetcher)),
    new FilePromptLoader(prompts)
  )
  const agent = await factory.create(implementation, { override })
  return { agent: agent as InstanceType<T>, workspace }
}

interface AgentImplementationLike {
  readonly definition: AgentDefinition
  new (executor: ReactAgent): Agent<{ prompt: string }, { text: string }>
}

function run(workspace: string, budget: ExecutionBudget): AgentExecution {
  return {
    identity: { executionId: 'guard-run' },
    scope: { threadId: 'guard-thread' },
    context: {
      budget,
      workspace: { root: workspace, writable: true }
    }
  }
}

function writableRun(workspace: string, budget: ExecutionBudget): AgentExecution {
  return {
    ...run(workspace, budget),
    context: {
      budget,
      workspace: { root: workspace, writable: true, writablePaths: ['game/scene/start.txt'] }
    }
  }
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

function textResponse(content: string, totalTokens: number): Record<string, unknown> {
  return {
    id: 'chatcmpl-ok',
    object: 'chat.completion',
    created: 1,
    model: 'chosen',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: totalTokens - 1,
      completion_tokens: 1,
      total_tokens: totalTokens
    }
  }
}

function toolResponse(
  name: string,
  args: unknown,
  totalTokens: number,
  callId = 'call_1'
): Record<string, unknown> {
  return {
    id: `chatcmpl-${callId}`,
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
              id: callId,
              type: 'function',
              function: { name, arguments: JSON.stringify(args) }
            }
          ]
        },
        finish_reason: 'tool_calls'
      }
    ],
    usage: {
      prompt_tokens: totalTokens - 1,
      completion_tokens: 1,
      total_tokens: totalTokens
    }
  }
}

function parallelToolsResponse(): Record<string, unknown> {
  return {
    id: 'chatcmpl-parallel',
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
            { id: 'call_fast', type: 'function', function: { name: 'fast', arguments: '{}' } },
            { id: 'call_slow', type: 'function', function: { name: 'slow', arguments: '{}' } }
          ]
        },
        finish_reason: 'tool_calls'
      }
    ],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }
  }
}

function sameToolBatchResponse(
  name: string,
  args: unknown,
  count: number
): Record<string, unknown> {
  return {
    id: 'chatcmpl-same-batch',
    object: 'chat.completion',
    created: 1,
    model: 'chosen',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: Array.from({ length: count }, (_, index) => ({
            id: `same_${index + 1}`,
            type: 'function',
            function: { name, arguments: JSON.stringify(args) }
          }))
        },
        finish_reason: 'tool_calls'
      }
    ],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }
  }
}

function multiToolResponse(names: readonly string[]): Record<string, unknown> {
  return {
    id: 'chatcmpl-batch',
    object: 'chat.completion',
    created: 1,
    model: 'chosen',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: names.map((name, index) => ({
            id: `call_${index + 1}`,
            type: 'function',
            function: { name, arguments: '{}' }
          }))
        },
        finish_reason: 'tool_calls'
      }
    ],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }
  }
}

function toolNames(body: Record<string, unknown>): string[] {
  const tools = body.tools as Array<{ function?: { name?: string } }> | undefined
  return (tools ?? []).flatMap((item) => (item.function?.name ? [item.function.name] : []))
}

function estimateRequestTokens(body: string): number {
  const parsed = JSON.parse(body) as { messages?: Array<{ content?: unknown }> }
  const text = (parsed.messages ?? [])
    .map((message) =>
      typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '')
    )
    .join('\n')
  let ascii = 0
  let tokens = 0
  for (const char of text) {
    if (char.charCodeAt(0) <= 0x7f) ascii += 1
    else tokens += 2
  }
  return tokens + Math.ceil(ascii / 3)
}

function messageText(message: { content?: unknown } | undefined): string {
  if (!message) return ''
  return typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
}

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-guard-'))
  roots.push(root)
  return root
}
