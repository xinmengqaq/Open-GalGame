import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

import type { Agent } from '@infrastructure/ai/agents/Agent'
import type { AgentDefinition } from '@infrastructure/ai/agents/AgentDefinition'
import type { AgentExecution } from '@infrastructure/ai/agents/AgentExecution'
import { ExecutionBudget } from '@infrastructure/ai/execution/ExecutionBudget'
import { FinalizeRequested } from '@infrastructure/ai/execution/executionErrors'
import { LangChainAgentFactoryImpl } from '@infrastructure/ai/factories/LangChainAgentFactoryImpl'
import { LangChainModelFactory } from '@infrastructure/ai/models/LangChainModelFactory'
import { FilePromptLoader } from '@infrastructure/ai/prompts/FilePromptLoader'
import { createWorkspaceFileTools } from '@infrastructure/ai/tools/WorkspaceFileTools'
import type { ReactAgent } from 'langchain'

import { streamingFetch } from './streamingFetch'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  vi.unstubAllEnvs()
})

it('文件在工具之外变化后，同参数再次读取仍执行', async () => {
  const budget = new ExecutionBudget({ modelAttempts: 8, toolCalls: 8, activeMs: 900000 })
  const { workspace, bodies } = await runFiles(
    [
      { name: 'readTextRange', args: { path: 'note.txt', start: 0, maxChars: 100 } },
      {
        name: 'readTextRange',
        args: { path: 'note.txt', start: 0, maxChars: 100 },
        mutate: (root) => writeFile(join(root, 'note.txt'), 'after-change')
      },
      { name: 'stop' }
    ],
    budget
  )

  expect(await readFile(join(workspace, 'note.txt'), 'utf8')).toBe('after-change')
  expect(JSON.stringify(bodies.at(-1))).toContain('after-change')
  expect(JSON.stringify(bodies)).not.toContain('未产生进展')
  expect(budget.errorAttempts).toBe(0)
})

it('目录在两次列目录之间变化时，后一次列目录仍执行', async () => {
  const budget = new ExecutionBudget({ modelAttempts: 8, toolCalls: 8, activeMs: 900000 })
  const { workspace, bodies } = await runFiles(
    [
      { name: 'readTextRange', args: { path: 'note.txt', start: 0, maxChars: 20 } },
      { name: 'listDirectory', args: { path: '' } },
      { name: 'readTextRange', args: { path: 'note.txt', start: 0, maxChars: 20 } },
      {
        name: 'listDirectory',
        args: { path: '' },
        mutate: (root) => writeFile(join(root, 'added.txt'), 'new')
      },
      { name: 'stop' }
    ],
    budget
  )

  expect(await readFile(join(workspace, 'added.txt'), 'utf8')).toBe('new')
  expect(JSON.stringify(bodies.at(-1))).toContain('added.txt')
  expect(JSON.stringify(bodies)).not.toContain('未产生进展')
  expect(budget.errorAttempts).toBe(0)
})

it('真实文件结果不变的重复读取会停止，且不消耗错误预算', async () => {
  const budget = new ExecutionBudget({ modelAttempts: 16, toolCalls: 16, activeMs: 900000 })
  const error = await runFiles(
    [{ name: 'readTextRange', args: { path: 'note.txt', start: 0, maxChars: 20 } }],
    budget
  ).catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(FinalizeRequested)
  expect(error).toMatchObject({ message: '需要收尾提交结构化结果' })
  expect(budget.errorAttempts).toBe(0)
  expect(budget.usage.toolCalls).toBeGreaterThan(2)
  expect(budget.usage.toolCalls).toBeLessThan(30)
})

class FileAgent implements Agent<{ prompt: string }, { text: string }> {
  static readonly definition: AgentDefinition = {
    id: 'repeat-plan',
    prompt: { agentId: 'repeat-plan' },
    createTools: createWorkspaceFileTools,
    execution: { technicalRetryCount: 0 }
  }

  constructor(private readonly executor: ReactAgent) {}

  async invoke(input: { prompt: string }, execution: AgentExecution): Promise<{ text: string }> {
    const result = await this.executor.invoke(
      { messages: [{ role: 'user', content: input.prompt }] },
      {
        signal: execution.signal,
        context: execution.context,
        configurable: { thread_id: execution.scope.threadId }
      }
    )
    const last = result.messages.at(-1)
    return {
      text: typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content)
    }
  }
}

type PlannedCall = {
  name: string
  args?: Record<string, unknown>
  mutate?: (workspace: string) => Promise<void>
}

async function runFiles(
  plan: readonly PlannedCall[],
  budget: ExecutionBudget
): Promise<{ workspace: string; bodies: unknown[] }> {
  const workspace = await mkdtemp(join(tmpdir(), 'repeat-plan-'))
  roots.push(workspace)
  await writeFile(join(workspace, 'note.txt'), 'before-change')
  const prompts = await mkdtemp(join(tmpdir(), 'repeat-plan-prompts-'))
  roots.push(prompts)
  await mkdir(join(prompts, 'repeat-plan'), { recursive: true })
  await writeFile(join(prompts, 'repeat-plan', 'system.md'), '读取授权工作区')
  const bodies: unknown[] = []
  let step = 0
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    bodies.push(body)
    if (JSON.stringify(body).includes('Context Extraction Assistant')) {
      return Response.json(textMessage('摘要'))
    }
    const planned = plan[Math.min(step, plan.length - 1)]!
    step += 1
    if (planned.mutate) await planned.mutate(workspace)
    if (planned.name === 'stop') return Response.json(textMessage('完成'))
    return Response.json(toolMessage(planned.name, planned.args ?? {}, step))
  })
  vi.stubEnv('OPENAI_API_KEY', 'ambient-openai-key')
  const factory = new LangChainAgentFactoryImpl(
    new LangChainModelFactory(
      async () => ({
        providerId: 'openai-compatible',
        baseUrl: 'https://service.example/v1',
        model: 'chosen',
        contextWindow: 8000,
        maxOutputTokens: 400,
        apiKey: 'stored-secret'
      }),
      streamingFetch(fetcher)
    ),
    new FilePromptLoader(resolve(prompts))
  )
  const agent = await factory.create(FileAgent, {
    override: { technicalRetryCount: 0, contextInputBudgetTokens: 4000 }
  })
  await agent.invoke(
    { prompt: '查看文件' },
    {
      identity: { executionId: 'repeat-plan' },
      scope: { threadId: 'repeat-plan-thread' },
      context: {
        budget,
        workspace: { root: workspace, writable: true }
      }
    }
  )
  return { workspace, bodies }
}

function textMessage(content: string): Record<string, unknown> {
  return {
    id: 'summary',
    object: 'chat.completion',
    created: 1,
    model: 'chosen',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }]
  }
}

function toolMessage(
  name: string,
  args: Record<string, unknown>,
  turn: number
): Record<string, unknown> {
  return {
    id: `chatcmpl-${turn}`,
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
              id: `call-${turn}`,
              type: 'function',
              function: { name, arguments: JSON.stringify(args) }
            }
          ]
        },
        finish_reason: 'tool_calls'
      }
    ]
  }
}
