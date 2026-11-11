import { streamingFetch } from './streamingFetch'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ClientTool } from '@langchain/core/tools'
import { tool, type ReactAgent } from 'langchain'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import type { ConnectionSettingsInfo } from '@domain/connections/models/ConnectionSettings'
import type { Agent } from '@infrastructure/ai/agents/Agent'
import type { AgentDefinition } from '@infrastructure/ai/agents/AgentDefinition'
import type { AgentExecution } from '@infrastructure/ai/agents/AgentExecution'
import { ExecutionBudget } from '@infrastructure/ai/execution/ExecutionBudget'
import { FinalizeRequested } from '@infrastructure/ai/execution/executionErrors'
import { LangChainAgentFactoryImpl } from '@infrastructure/ai/factories/LangChainAgentFactoryImpl'
import { LangChainModelFactory } from '@infrastructure/ai/models/LangChainModelFactory'
import { FilePromptLoader } from '@infrastructure/ai/prompts/FilePromptLoader'

const roots: string[] = []
const NUDGE = '[执行约束]'
const settings: ConnectionSettingsInfo = {
  providerId: 'openai-compatible',
  baseUrl: 'https://service.example/v1',
  model: 'chosen',
  contextWindow: 4000,
  maxOutputTokens: 200,
  apiKey: 'stored-secret'
}

const hooks: {
  readRange: (input: { path: string; start: number; maxChars?: number }) => string
} = {
  readRange: () => 'same-body'
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('readTextRange 读取进展判定', () => {
  it('同一起点只切换 maxChars 仍按无进展停止', async () => {
    resetHook()
    let round = 0
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      if (toolCount(init) >= 12) return Response.json(textResponse('完成'))
      round += 1
      return Response.json(
        toolResponse(
          'readTextRange',
          { path: '/skills/a.md', start: 0, maxChars: 100 + round },
          `read_${round}`
        )
      )
    })
    const { agent, workspace } = await createAgent(fetcher)
    const budget = new ExecutionBudget({ modelAttempts: 20, toolCalls: 20, activeMs: 900000 })

    const error = await agent
      .invoke({ prompt: '重复读取' }, run(workspace, budget))
      .catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(FinalizeRequested)
    expect(error).toMatchObject({ message: '需要收尾提交结构化结果' })
    expect(budget.errorAttempts).toBe(0)
    expect(fetcher.mock.calls.length).toBeLessThan(12)
  })

  it('扩大窗口返回新行算进展', async () => {
    resetHook()
    hooks.readRange = (input) => 'line\n'.repeat(input.maxChars ?? 100)
    const bodies: string[] = []
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body))
      const seen = toolCount(init)
      if (seen >= 2) return Response.json(textResponse('完成'))
      return Response.json(
        toolResponse(
          'readTextRange',
          { path: '/skills/a.md', start: 0, maxChars: seen === 0 ? 100 : 150 },
          `read_${seen}`
        )
      )
    })
    const { agent, workspace } = await createAgent(fetcher)
    const budget = new ExecutionBudget({ modelAttempts: 10, toolCalls: 10, activeMs: 900000 })

    await expect(agent.invoke({ prompt: '扩窗' }, run(workspace, budget))).resolves.toMatchObject({
      text: expect.stringContaining('完成')
    })
    expect(bodies.some((body) => body.includes(NUDGE))).toBe(false)
    expect(budget.errorAttempts).toBe(0)
  })

  it('不同起点的续页正文不误判为重复', async () => {
    resetHook()
    hooks.readRange = (input) => `page-${input.start}`
    const bodies: string[] = []
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body))
      const seen = toolCount(init)
      if (seen >= 3) return Response.json(textResponse('完成'))
      return Response.json(
        toolResponse(
          'readTextRange',
          { path: '/skills/a.md', start: seen * 100, maxChars: 100 },
          `page_${seen}`
        )
      )
    })
    const { agent, workspace } = await createAgent(fetcher)
    const budget = new ExecutionBudget({ modelAttempts: 10, toolCalls: 10, activeMs: 900000 })

    await expect(agent.invoke({ prompt: '续页' }, run(workspace, budget))).resolves.toMatchObject({
      text: expect.stringContaining('完成')
    })
    expect(bodies.some((body) => body.includes(NUDGE))).toBe(false)
    expect(budget.errorAttempts).toBe(0)
  })

  it('同一批不同 maxChars 的相同读取只结算一次', async () => {
    resetHook()
    const bodies: string[] = []
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body))
      if (toolCount(init) >= 6) return Response.json(textResponse('完成'))
      return Response.json(
        sameToolBatchResponse(
          'readTextRange',
          Array.from({ length: 6 }, (_, index) => ({
            path: '/skills/a.md',
            start: 0,
            maxChars: 100 + index * 10
          })),
          'batch_1'
        )
      )
    })
    const { agent, workspace } = await createAgent(fetcher)
    const budget = new ExecutionBudget({ modelAttempts: 10, toolCalls: 10, activeMs: 900000 })

    await expect(agent.invoke({ prompt: '同批' }, run(workspace, budget))).resolves.toMatchObject({
      text: expect.stringContaining('完成')
    })
    expect(bodies.some((body) => body.includes(NUDGE))).toBe(false)
    expect(budget.errorAttempts).toBe(0)
  })

  it('探索提示后成功写入会清空读取无进展', async () => {
    resetHook()
    const bodies: string[] = []
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body))
      const seen = toolCount(init)
      if (seen === 0) {
        return Response.json(
          toolResponse(
            'readTextRange',
            { path: '/skills/a.md', start: 0, maxChars: 100 },
            'read_1'
          )
        )
      }
      if (seen === 1) {
        return Response.json(
          toolResponse(
            'readTextRange',
            { path: '/skills/a.md', start: 0, maxChars: 150 },
            'read_2'
          )
        )
      }
      if (seen === 2) {
        return Response.json(
          toolResponse(
            'readTextRange',
            { path: '/skills/a.md', start: 0, maxChars: 200 },
            'read_3'
          )
        )
      }
      if (seen === 3) {
        return Response.json(
          toolResponse(
            'writeText',
            { path: 'game/scene/start.txt', content: 'candidate' },
            'write_1'
          )
        )
      }
      if (seen === 4) {
        return Response.json(
          toolResponse(
            'readTextRange',
            { path: '/skills/a.md', start: 0, maxChars: 250 },
            'read_4'
          )
        )
      }
      return Response.json(textResponse('完成'))
    })
    const { agent, workspace } = await createAgent(fetcher)
    const budget = new ExecutionBudget({ modelAttempts: 20, toolCalls: 20, activeMs: 900000 })

    await expect(
      agent.invoke({ prompt: '先读后写' }, writableRun(workspace, budget))
    ).resolves.toMatchObject({ text: expect.stringContaining('完成') })
    expect(bodies.some((body) => body.includes(NUDGE))).toBe(true)
    expect(budget.errorAttempts).toBe(0)
  })
})

const ReadProgressAgent = defineAgent('read-progress', () => [
  tool(
    async (input: { path: string; start: number; maxChars?: number }) => hooks.readRange(input),
    {
      name: 'readTextRange',
      description: '读取候选文件',
      schema: z.object({
        path: z.string(),
        start: z.number().int().nonnegative(),
        maxChars: z.number().int().positive().optional()
      })
    }
  ),
  tool(async (input: { path: string; content: string }) => input.content, {
    name: 'writeText',
    description: '写入候选',
    schema: z.object({ path: z.string(), content: z.string() })
  })
])

function defineAgent(
  id: string,
  createTools: () => ClientTool[]
): new (executor: ReactAgent) => Agent<{ prompt: string }, { text: string }> {
  return class implements Agent<{ prompt: string }, { text: string }> {
    static readonly definition: AgentDefinition = {
      id,
      prompt: { agentId: id },
      createTools,
      execution: { technicalRetryCount: 0 }
    }

    constructor(private readonly executor: ReactAgent) {}

    async invoke(input: { prompt: string }, current: AgentExecution): Promise<{ text: string }> {
      const result = await this.executor.invoke(
        { messages: [{ role: 'user', content: input.prompt }] },
        invokeConfig(current)
      )
      const last = result.messages.at(-1) as { content?: unknown } | undefined
      return {
        text: typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '')
      }
    }
  }
}

function resetHook(): void {
  hooks.readRange = () => 'same-body'
}

async function createAgent(
  fetcher: typeof fetch
): Promise<{ agent: Agent<{ prompt: string }, { text: string }>; workspace: string }> {
  vi.stubEnv('OPENAI_API_KEY', 'ambient-openai-key')
  const prompts = await createRoot()
  const id = 'read-progress'
  await mkdir(join(prompts, id), { recursive: true })
  await writeFile(join(prompts, id, 'system.md'), `${id} 提示`)
  const workspace = await createRoot()
  const factory = new LangChainAgentFactoryImpl(
    new LangChainModelFactory(async () => settings, streamingFetch(fetcher)),
    new FilePromptLoader(prompts)
  )
  const agent = await factory.create(ReadProgressAgent, { override: { technicalRetryCount: 0 } })
  return { agent, workspace }
}

function run(workspace: string, budget: ExecutionBudget): AgentExecution {
  return {
    identity: { executionId: 'read-progress-run' },
    scope: { threadId: 'read-progress-thread' },
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
      workspace: {
        root: workspace,
        writable: true,
        writablePaths: ['game/scene/start.txt']
      }
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

function toolCount(init?: RequestInit): number {
  const body = JSON.parse(String(init?.body)) as { messages?: Array<{ role?: string }> }
  return body.messages?.filter((message) => message.role === 'tool').length ?? 0
}

function textResponse(content: string): Record<string, unknown> {
  return {
    id: 'chatcmpl-ok',
    object: 'chat.completion',
    created: 1,
    model: 'chosen',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  }
}

function toolResponse(name: string, args: unknown, callId: string): Record<string, unknown> {
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
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  }
}

function sameToolBatchResponse(
  name: string,
  argsList: readonly unknown[],
  callId: string
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
          tool_calls: argsList.map((args, index) => ({
            id: `${callId}_${index + 1}`,
            type: 'function',
            function: { name, arguments: JSON.stringify(args) }
          }))
        },
        finish_reason: 'tool_calls'
      }
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  }
}

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'read-progress-'))
  roots.push(root)
  return root
}
