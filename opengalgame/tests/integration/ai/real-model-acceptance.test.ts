import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tool, toolStrategy, type ReactAgent } from 'langchain'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import type { Agent } from '@infrastructure/ai/agents/Agent'
import type { AgentDefinition } from '@infrastructure/ai/agents/AgentDefinition'
import type { AgentExecution } from '@infrastructure/ai/agents/AgentExecution'
import { ExecutionBudget } from '@infrastructure/ai/execution/ExecutionBudget'
import { LangChainAgentFactoryImpl } from '@infrastructure/ai/factories/LangChainAgentFactoryImpl'
import { LangChainModelFactory } from '@infrastructure/ai/models/LangChainModelFactory'
import { FilePromptLoader } from '@infrastructure/ai/prompts/FilePromptLoader'
import { createWorkspaceFileTools } from '@infrastructure/ai/tools/WorkspaceFileTools'
import type { ConnectionSettingsInfo } from '@domain/settings/connections/models/ConnectionSettings'

const enabled = process.env.OPENGALGAME_RUN_REAL_MODEL === '1'

vi.setConfig({ testTimeout: 0 })
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

type SafeStageName = 'setup' | 'plain' | 'file' | 'default' | 'small' | 'structured'

type SafeFacts = {
  tokens: number | null
  toolCalls: number | null
  modelAttempts: number | null
}

type SafeStageRecord = SafeFacts & {
  stage: SafeStageName
  check: string
  actual: boolean
  errorType: string | null
  status: number | null
}

type SafeCheck = (id: string, assertion: () => void) => void

type SafeLedger = {
  run: <T>(
    stage: SafeStageName,
    budget: ExecutionBudget | null,
    body: (check: SafeCheck) => Promise<T>
  ) => Promise<T>
  wrap: <T>(body: () => Promise<T>) => Promise<T>
}

const SAFE_ID = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u

function safeCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null
}

function factsOf(budget: ExecutionBudget | null): SafeFacts {
  try {
    const usage = budget?.usage
    return {
      tokens: safeCount(usage?.tokens),
      toolCalls: safeCount(usage?.toolCalls),
      modelAttempts: safeCount(usage?.modelAttempts)
    }
  } catch {
    return { tokens: null, toolCalls: null, modelAttempts: null }
  }
}

function errorFacts(error: unknown): { errorType: string | null; status: number | null } {
  let errorType: string | null = null
  let status: number | null = null
  let current: unknown = error
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    try {
      const record = current as Record<string, unknown>
      if (errorType === null && typeof record.name === 'string' && SAFE_ID.test(record.name)) {
        errorType = record.name
      }
      if (status === null) {
        const response = record.response
        const candidate =
          typeof record.status === 'number'
            ? record.status
            : typeof record.statusCode === 'number'
              ? record.statusCode
              : response && typeof response === 'object'
                ? (response as Record<string, unknown>).status
                : undefined
        if (
          typeof candidate === 'number' &&
          Number.isInteger(candidate) &&
          candidate >= 100 &&
          candidate <= 599
        ) {
          status = candidate
        }
      }
      current = record.cause
    } catch {
      break
    }
  }
  return { errorType, status }
}

function createSafeLedger(meta: object | undefined): SafeLedger {
  const records: SafeStageRecord[] = []
  let lastStage: SafeStageName = 'setup'

  function attach(): void {
    if (!meta) return
    try {
      ;(meta as Record<string, unknown>).safeStages = records
    } catch {
    }
  }

  async function flush(): Promise<void> {
    attach()
    const dir = process.env.OPENGALGAME_SCENE_ACCEPTANCE_DIR
    if (!dir) return
    try {
      await mkdir(join(dir, 'direct'), { recursive: true })
      await writeFile(
        join(dir, 'direct', 'safe-assertions.json'),
        `${JSON.stringify({ version: 1, records }, null, 2)}\n`,
        'utf8'
      )
    } catch {
    }
  }

  async function run<T>(
    stage: SafeStageName,
    budget: ExecutionBudget | null,
    body: (check: SafeCheck) => Promise<T>
  ): Promise<T> {
    lastStage = stage
    let checkFailed = false
    const check = (id: string, assertion: () => void): void => {
      try {
        assertion()
        try {
          records.push({
            stage,
            check: id,
            actual: true,
            ...factsOf(budget),
            errorType: null,
            status: null
          })
        } catch {
        }
      } catch (error) {
        checkFailed = true
        try {
          records.push({
            stage,
            check: id,
            actual: false,
            ...factsOf(budget),
            ...errorFacts(error)
          })
        } catch {
        }
        throw error
      }
    }

    let failure: unknown
    let failed = false
    try {
      return await body(check)
    } catch (error) {
      failure = error
      failed = true
      throw error
    } finally {
      if (failed && !checkFailed) {
        try {
          records.push({
            stage,
            check: 'stage.aborted',
            actual: false,
            ...factsOf(budget),
            ...errorFacts(failure)
          })
        } catch {
        }
      }
    }
  }

  async function wrap<T>(body: () => Promise<T>): Promise<T> {
    let failure: unknown
    let failed = false
    try {
      return await body()
    } catch (error) {
      failure = error
      failed = true
      throw error
    } finally {
      if (failed && !records.some((record) => record.actual === false)) {
        try {
          records.push({
            stage: lastStage,
            check: 'test.aborted',
            actual: false,
            ...factsOf(null),
            ...errorFacts(failure)
          })
        } catch {
        }
      }
      await flush()
    }
  }

  attach()
  return { run, wrap }
}

describe.skipIf(!enabled)('真实模型验收', () => {
  it('普通调用、文件工具循环和结构化输出都计入真实用量', async (ctx) => {
    const ledger = createSafeLedger(ctx.task.meta)
    await ledger.wrap(async () => {
      const { factory } = await ledger.run('setup', null, async () => {
        const settings = await acceptanceSettings()
        const prompts = await createRoot()
        for (const id of ['plain-model', 'file-model', 'structured-model']) {
          await mkdir(join(prompts, id))
          await writeFile(join(prompts, id, 'system.md'), '只完成用户要求的动作，不要展开说明。')
        }
        return {
          factory: new LangChainAgentFactoryImpl(
            new LangChainModelFactory(async () => settings),
            new FilePromptLoader(prompts)
          )
        }
      })

      const plainBudget = new ExecutionBudget({
        modelAttempts: 2,
        toolCalls: 1,
        activeMs: Number.MAX_SAFE_INTEGER,
        tokens: 4000
      })
      await ledger.run('plain', plainBudget, async (check) => {
        const plain = await factory.create(PlainModelAgent, {
          override: { technicalRetryCount: 0, modelAttemptLimit: 2, toolCallLimit: 1 },
          model: { override: { maxOutputTokens: 32 } }
        })
        const result = await plain.invoke(
          { prompt: '只回复 ok' },
          run(await createRoot(), plainBudget)
        )
        check('plain.text.ok', () =>
          expect(result.text.toLowerCase().includes('ok')).toBe(true)
        )
        check('plain.tokens.gt0', () =>
          expect(plainBudget.usage.tokens).toBeGreaterThan(0)
        )
        check('plain.attempts.eq1', () =>
          expect(plainBudget.usage.modelAttempts).toBe(1)
        )
      })

      const fileBudget = new ExecutionBudget({
        modelAttempts: 4,
        toolCalls: 2,
        activeMs: Number.MAX_SAFE_INTEGER,
        tokens: 8000
      })
      await ledger.run('file', fileBudget, async (check) => {
        const marker = `mark-${randomBytes(8).toString('hex')}`
        const workspace = await createRoot()
        await writeFile(join(workspace, 'note.txt'), marker)
        const fileAgent = await factory.create(FileModelAgent, {
          override: { technicalRetryCount: 0, modelAttemptLimit: 4, toolCallLimit: 2 },
          model: { override: { maxOutputTokens: 256 } }
        })
        const result = await fileAgent.invoke(
          { prompt: '用 readTextRange 读取 note.txt 的开头，然后只回复文件中的原文。' },
          run(workspace, fileBudget)
        )
        check('file.text.marker', () => expect(result.text.includes(marker)).toBe(true))
        check('file.tools.gt0', () =>
          expect(fileBudget.usage.toolCalls).toBeGreaterThan(0)
        )
        check('file.tokens.gt.plain', () =>
          expect(fileBudget.usage.tokens).toBeGreaterThan(plainBudget.usage.tokens)
        )
        check('file.attempts.le4', () =>
          expect(fileBudget.usage.modelAttempts).toBeLessThanOrEqual(4)
        )
      })

      const defaultBudget = new ExecutionBudget({
        modelAttempts: 16,
        toolCalls: 32,
        activeMs: Number.MAX_SAFE_INTEGER,
        tokens: 8000
      })
      await ledger.run('default', defaultBudget, async (check) => {
        const defaultMarker = `mark-${randomBytes(8).toString('hex')}`
        const defaultWorkspace = await createRoot()
        await writeFile(join(defaultWorkspace, 'note.txt'), defaultMarker)
        const defaultAgent = await factory.create(FileModelAgent, {
          override: { technicalRetryCount: 0 },
          model: { override: { maxOutputTokens: 256 } }
        })
        const result = await defaultAgent.invoke(
          { prompt: '用 readTextRange 读取 note.txt 的开头，然后只回复文件中的原文。' },
          run(defaultWorkspace, defaultBudget)
        )
        check('default.text.marker', () =>
          expect(result.text.includes(defaultMarker)).toBe(true)
        )
        check('default.tools.gt0', () =>
          expect(defaultBudget.usage.toolCalls).toBeGreaterThan(0)
        )
        check('default.attempts.gt0', () =>
          expect(defaultBudget.usage.modelAttempts).toBeGreaterThan(0)
        )
        check('default.attempts.le4', () =>
          expect(defaultBudget.usage.modelAttempts).toBeLessThanOrEqual(4)
        )
        check('default.tokens.gt0', () =>
          expect(defaultBudget.usage.tokens).toBeGreaterThan(0)
        )
      })

      const smallBudget = new ExecutionBudget({
        modelAttempts: 2,
        toolCalls: 1,
        activeMs: Number.MAX_SAFE_INTEGER,
        tokens: 8000
      })
      await ledger.run('small', smallBudget, async (check) => {
        const smallMarker = `mark-${randomBytes(8).toString('hex')}`
        const smallWorkspace = await createRoot()
        await writeFile(join(smallWorkspace, 'note.txt'), smallMarker)
        const smallAgent = await factory.create(FileModelAgent, {
          override: { technicalRetryCount: 0, modelAttemptLimit: 2, toolCallLimit: 1 },
          model: { override: { maxOutputTokens: 256 } }
        })
        const result = await smallAgent.invoke(
          { prompt: '用 readTextRange 读取 note.txt 的开头，然后只回复文件中的原文。' },
          run(smallWorkspace, smallBudget)
        )
        check('small.text.marker', () =>
          expect(result.text.includes(smallMarker)).toBe(true)
        )
        check('small.attempts.le2', () =>
          expect(smallBudget.usage.modelAttempts).toBeLessThanOrEqual(2)
        )
        check('small.tools.eq1', () => expect(smallBudget.usage.toolCalls).toBe(1))
        check('small.tokens.gt0', () =>
          expect(smallBudget.usage.tokens).toBeGreaterThan(0)
        )
      })

      const structuredBudget = new ExecutionBudget({
        modelAttempts: 2,
        toolCalls: 1,
        activeMs: Number.MAX_SAFE_INTEGER,
        tokens: 4000
      })
      await ledger.run('structured', structuredBudget, async (check) => {
        const structured = await factory.create(StructuredModelAgent, {
          override: { technicalRetryCount: 0, modelAttemptLimit: 2, toolCallLimit: 1 },
          model: { override: { maxOutputTokens: 64 } }
        })
        const result = await structured.invoke(
          { prompt: 'answer 字段只写 ok' },
          run(await createRoot(), structuredBudget)
        )
        const structuredAnswer = (result.structured as { answer?: unknown } | undefined)?.answer
        check('structured.answer.ok', () =>
          expect(
            typeof structuredAnswer === 'string' && /ok/i.test(structuredAnswer)
          ).toBe(true)
        )
        check('structured.tokens.gt0', () =>
          expect(structuredBudget.usage.tokens).toBeGreaterThan(0)
        )
      })
    })
  })
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
  const session = env.OPENGALGAME_OPENCODE_SESSION?.trim()
  return {
    providerId,
    baseUrl: env.OPENGALGAME_BASE_URL ?? '',
    model: env.OPENGALGAME_MODEL ?? '',
    apiKey,
    contextWindow: 8000,
    maxOutputTokens: 256,
    ...(session
      ? { extension: { defaultHeaders: { 'x-opencode-session': session } } }
      : {})
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
