import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tool, toolStrategy, type ReactAgent } from 'langchain'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import type { Agent } from '@infrastructure/ai/agents/Agent'
import type { AgentDefinition } from '@infrastructure/ai/agents/AgentDefinition'
import type { AgentExecution } from '@infrastructure/ai/agents/AgentExecution'
import { ExecutionBudget } from '@infrastructure/ai/execution/ExecutionBudget'
import { LangChainAgentFactoryImpl } from '@infrastructure/ai/factories/LangChainAgentFactoryImpl'
import { LangChainModelFactory } from '@infrastructure/ai/models/LangChainModelFactory'
import { FilePromptLoader } from '@infrastructure/ai/prompts/FilePromptLoader'
import { createWorkspaceFileTools } from '@infrastructure/ai/tools/WorkspaceFileTools'
import type { ConnectionSettingsInfo } from '@domain/connections/models/ConnectionSettings'

const enabled = process.env.OPENGALGAME_RUN_REAL_MODEL === '1'
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe.skipIf(!enabled)('真实模型验收', () => {
  it('普通调用、文件工具循环和结构化输出都计入真实用量', async () => {
    const settings = await acceptanceSettings()
    const prompts = await createRoot()
    for (const id of ['plain-model', 'file-model', 'structured-model']) {
      await mkdir(join(prompts, id))
      await writeFile(join(prompts, id, 'system.md'), '只完成用户要求的动作，不要展开说明。')
    }
    const factory = new LangChainAgentFactoryImpl(
      new LangChainModelFactory(async () => settings),
      new FilePromptLoader(prompts)
    )
    const plainBudget = new ExecutionBudget({
      modelAttempts: 2,
      toolCalls: 1,
      activeMs: 120000,
      tokens: 4000
    })
    const plain = await factory.create(PlainModelAgent, {
      override: { technicalRetryCount: 0, modelAttemptLimit: 2, toolCallLimit: 1 },
      model: { override: { maxOutputTokens: 32 } }
    })
    const plainResult = await plain.invoke(
      { prompt: '只回复 ok' },
      run(await createRoot(), plainBudget)
    )
    expect(plainResult.text.toLowerCase()).toContain('ok')
    expect(plainBudget.usage.tokens).toBeGreaterThan(0)
    expect(plainBudget.usage.modelAttempts).toBe(1)

    const marker = `mark-${randomBytes(8).toString('hex')}`
    const workspace = await createRoot()
    await writeFile(join(workspace, 'note.txt'), marker)
    const fileBudget = new ExecutionBudget({
      modelAttempts: 4,
      toolCalls: 2,
      activeMs: 180000,
      tokens: 8000
    })
    const fileAgent = await factory.create(FileModelAgent, {
      override: { technicalRetryCount: 0, modelAttemptLimit: 4, toolCallLimit: 2 },
      model: { override: { maxOutputTokens: 256 } }
    })
    const fileResult = await fileAgent.invoke(
      { prompt: '用 readTextRange 读取 note.txt 的开头，然后只回复文件中的原文。' },
      run(workspace, fileBudget)
    )
    expect(fileResult.text).toContain(marker)
    expect(fileBudget.usage.toolCalls).toBeGreaterThan(0)
    expect(fileBudget.usage.tokens).toBeGreaterThan(plainBudget.usage.tokens)
    expect(fileBudget.usage.modelAttempts).toBeLessThanOrEqual(4)

    const defaultWorkspace = await createRoot()
    const defaultMarker = `mark-${randomBytes(8).toString('hex')}`
    await writeFile(join(defaultWorkspace, 'note.txt'), defaultMarker)
    const defaultBudget = new ExecutionBudget({
      modelAttempts: 16,
      toolCalls: 32,
      activeMs: 180000,
      tokens: 8000
    })
    const defaultAgent = await factory.create(FileModelAgent, {
      override: { technicalRetryCount: 0 },
      model: { override: { maxOutputTokens: 256 } }
    })
    const defaultResult = await defaultAgent.invoke(
      { prompt: '用 readTextRange 读取 note.txt 的开头，然后只回复文件中的原文。' },
      run(defaultWorkspace, defaultBudget)
    )
    expect(defaultResult.text).toContain(defaultMarker)
    expect(defaultBudget.usage.toolCalls).toBeGreaterThan(0)
    expect(defaultBudget.usage.modelAttempts).toBeGreaterThan(0)
    expect(defaultBudget.usage.modelAttempts).toBeLessThanOrEqual(4)
    expect(defaultBudget.usage.tokens).toBeGreaterThan(0)

    const smallWorkspace = await createRoot()
    const smallMarker = `mark-${randomBytes(8).toString('hex')}`
    await writeFile(join(smallWorkspace, 'note.txt'), smallMarker)
    const smallBudget = new ExecutionBudget({
      modelAttempts: 2,
      toolCalls: 1,
      activeMs: 180000,
      tokens: 8000
    })
    const smallAgent = await factory.create(FileModelAgent, {
      override: { technicalRetryCount: 0, modelAttemptLimit: 2, toolCallLimit: 1 },
      model: { override: { maxOutputTokens: 256 } }
    })
    const smallResult = await smallAgent.invoke(
      { prompt: '用 readTextRange 读取 note.txt 的开头，然后只回复文件中的原文。' },
      run(smallWorkspace, smallBudget)
    )
    expect(smallResult.text).toContain(smallMarker)
    expect(smallBudget.usage.modelAttempts).toBeLessThanOrEqual(2)
    expect(smallBudget.usage.toolCalls).toBe(1)
    expect(smallBudget.usage.tokens).toBeGreaterThan(0)

    const structuredBudget = new ExecutionBudget({
      modelAttempts: 2,
      toolCalls: 1,
      activeMs: 120000,
      tokens: 4000
    })
    const structured = await factory.create(StructuredModelAgent, {
      override: { technicalRetryCount: 0, modelAttemptLimit: 2, toolCallLimit: 1 },
      model: { override: { maxOutputTokens: 64 } }
    })
    const structuredResult = await structured.invoke(
      { prompt: 'answer 字段只写 ok' },
      run(await createRoot(), structuredBudget)
    )
    expect(structuredResult.structured).toMatchObject({ answer: expect.stringMatching(/ok/i) })
    expect(structuredBudget.usage.tokens).toBeGreaterThan(0)
  }, 180000)
})

class PlainModelAgent implements Agent<{ prompt: string }, { text: string }> {
  static readonly definition: AgentDefinition = {
    id: 'plain-model',
    prompt: { agentId: 'plain-model' },
    createTools: () => [],
    execution: { technicalRetryCount: 0 }
  }

  constructor(private readonly executor: ReactAgent) {}

  async invoke(input: { prompt: string }, current: AgentExecution): Promise<{ text: string }> {
    const result = await this.executor.invoke(
      { messages: [{ role: 'user', content: input.prompt }] },
      invokeConfig(current)
    )
    return { text: textOf(result.messages.at(-1)) }
  }
}

class FileModelAgent implements Agent<{ prompt: string }, { text: string }> {
  static readonly definition: AgentDefinition = {
    id: 'file-model',
    prompt: { agentId: 'file-model' },
    createTools: () => createWorkspaceFileTools(),
    execution: { technicalRetryCount: 0 }
  }

  constructor(private readonly executor: ReactAgent) {}

  async invoke(input: { prompt: string }, current: AgentExecution): Promise<{ text: string }> {
    const result = await this.executor.invoke(
      { messages: [{ role: 'user', content: input.prompt }] },
      invokeConfig(current)
    )
    return { text: textOf(result.messages.at(-1)) }
  }
}

class StructuredModelAgent implements Agent<
  { prompt: string },
  { text: string; structured?: unknown }
> {
  static readonly definition: AgentDefinition = {
    id: 'structured-model',
    prompt: { agentId: 'structured-model' },
    createTools: () => [
      tool(async () => 'unused', {
        name: 'echo',
        description: '不使用',
        schema: z.object({ text: z.string() })
      })
    ],
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
    return {
      text: textOf(result.messages.at(-1)),
      structured: result.structuredResponse
    }
  }
}

async function acceptanceSettings(): Promise<ConnectionSettingsInfo> {
  const env = parseEnv(await readFile(join(process.cwd(), '.env'), 'utf8'))
  const providerId = env.OPENGALGAME_PROVIDER_ID
  if (providerId !== 'openai-compatible' && providerId !== 'anthropic') {
    throw new Error('验收配置缺少协议')
  }
  const apiKey = env.OPENGALGAME_API_KEY ?? ''
  if (apiKey.trim().length === 0) throw new Error('验收配置缺少密钥')
  return {
    providerId,
    baseUrl: env.OPENGALGAME_BASE_URL ?? '',
    model: env.OPENGALGAME_MODEL ?? '',
    apiKey,
    contextWindow: 8000,
    maxOutputTokens: 256
  }
}

function parseEnv(text: string): Record<string, string> {
  const entries: Record<string, string> = {}
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    const separator = trimmed.indexOf('=')
    if (separator < 0) continue
    entries[trimmed.slice(0, separator)] = trimmed.slice(separator + 1)
  }
  return entries
}

function run(workspace: string, budget: ExecutionBudget): AgentExecution {
  return {
    identity: { executionId: 'real-model' },
    scope: { threadId: `real-${randomBytes(4).toString('hex')}` },
    context: { budget, workspace: { root: workspace, writable: true } }
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

function textOf(message: { content?: unknown } | undefined): string {
  if (!message) return ''
  return typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
}

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'real-model-'))
  roots.push(root)
  return root
}
