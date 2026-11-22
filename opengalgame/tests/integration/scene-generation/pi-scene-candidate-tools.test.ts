import { createHash } from 'node:crypto'
import type * as FsPromises from 'node:fs/promises'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Agent } from '@earendil-works/pi-agent-core'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxProviderHandle
} from '@earendil-works/pi-ai/providers/faux'
import { ExecutionBudget } from '@infrastructure/ai/execution/ExecutionBudget'
import type { AgentProgressEvent } from '@infrastructure/ai/execution/AgentProgress'
import { PiAgentExecutor } from '@infrastructure/ai/pi/PiAgentExecutor'
import type { PiModelRuntime } from '@infrastructure/ai/pi/PiModelFactory'
import type { AgentStreamEvent } from '@infrastructure/ai/streaming/AgentStreamEvent'
import {
  SceneCandidateToolbox,
  readSceneDraft
} from '@infrastructure/scene-generation/pi/SceneCandidateToolbox'

const fsGate = vi.hoisted(() => ({
  readFile: undefined as ((path: string) => Promise<void>) | undefined
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    readFile: async (path: unknown, ...args: unknown[]) => {
      if (fsGate.readFile && String(path).includes('.opengalgame-tmp-'))
        await fsGate.readFile(String(path))
      return (actual.readFile as (...values: unknown[]) => Promise<unknown>)(path, ...args)
    }
  }
})

const roots: string[] = []

afterEach(async () => {
  fsGate.readFile = undefined
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('真实 Pi 循环拒绝未授权读和越界写，写后仅记录实际摘要', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-scene-tools-'))
  roots.push(root)
  const entryPath = 'game/scene/start.txt'
  const entry = join(root, entryPath)
  await mkdir(join(root, 'game/scene'), { recursive: true })
  await mkdir(join(root, 'input'), { recursive: true })
  await writeFile(entry, 'say:种子 -clear;')
  await writeFile(join(root, 'input/cards.md'), 'CARD-SECRET-ALLOWED')
  await writeFile(join(root, 'input/unlisted.md'), 'UNLISTED-SECRET')
  const seedDigest = await digestOf(entry)
  const budget = new ExecutionBudget({ modelAttempts: 8, toolCalls: 8, activeMs: 60_000 })
  const controller = new AbortController()
  const toolbox = new SceneCandidateToolbox({
    workspaceRoot: root,
    entryPath,
    authority: { files: new Set([entryPath, 'input/cards.md']), inputs: new Map() },
    budget,
    signal: controller.signal,
    toolResultCharLimit: 8000
  })
  const faux = fauxProvider()
  const entryRevision = await digestOf(entry)
  const newScript = 'changeBg:station.svg;\nsay:新候选 -clear;\nend;'
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall('readTextRange', { path: 'input/unlisted.md', start: 0, maxChars: 80 }),
      { stopReason: 'toolUse' }
    ),
    fauxAssistantMessage(
      fauxToolCall('readTextRange', { path: 'input/cards.md', start: 0, maxChars: 80 }),
      { stopReason: 'toolUse' }
    ),
    fauxAssistantMessage(
      fauxToolCall('writeCandidate', {
        path: 'game/scene/other.txt',
        expectedRevision: entryRevision,
        content: newScript
      }),
      { stopReason: 'toolUse' }
    ),
    fauxAssistantMessage(
      fauxToolCall('writeCandidate', {
        path: entryPath,
        expectedRevision: entryRevision,
        content: newScript
      }),
      { stopReason: 'toolUse' }
    ),
    fauxAssistantMessage('done')
  ])
  const progress: AgentProgressEvent[] = []
  const events: AgentStreamEvent[] = []
  const result = await createExecutor(faux).run({
    systemPrompt: 'SYS',
    prompt: '生成候选',
    tools: toolbox.tools,
    signal: controller.signal,
    identity: { executionId: 'execution', agentId: 'webgal-scene', runId: 'run' },
    budget,
    progress: (event) => progress.push(event),
    observation: { subscriptions: [{ onEvent: (event) => events.push(event) }] },
    hooks: {
      finishTurn: async () => (toolbox.hasWritten ? ({ action: 'end' } as const) : undefined)
    }
  })

  expect(result.status).toBe('succeeded')
  expect(toolbox.writtenFiles).toHaveLength(1)
  expect(await readFile(entry, 'utf8')).toBe(newScript)
  expect(await readFile(join(root, 'game/scene/other.txt')).catch(() => null)).toBeNull()
  const written = toolbox.lastWrite!
  expect(written.digest).toBe(await digestOf(entry))
  expect(written.digest).not.toBe(seedDigest)
  const transcript = JSON.stringify(result.messages)
  expect(transcript).toContain('CARD-SECRET-ALLOWED')
  expect(transcript).not.toContain('UNLISTED-SECRET')
  expect(transcript).toContain('路径不在本次获准读取清单')
  expect(transcript).toContain('文件不在本次候选写入清单')

  const toolEvents = progress.filter(
    (event) => event.kind === 'tool-start' || event.kind === 'tool-end'
  )
  expect(toolEvents).toHaveLength(8)
  expect(toolEvents.map((event) => event.kind)).toEqual([
    'tool-start',
    'tool-end',
    'tool-start',
    'tool-end',
    'tool-start',
    'tool-end',
    'tool-start',
    'tool-end'
  ])
  const toolStream = events.filter((event) => event.type === 'tool')
  expect(toolStream.at(-1)).toMatchObject({ status: 'succeeded', toolName: 'writeCandidate' })
  expect(events.filter((event) => event.type === 'run').map((event) => event.status)).toEqual([
    'started',
    'succeeded'
  ])
})

it('写盘中断取消时不替换候选，迟到工具事件只标记中断', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-scene-cancel-'))
  roots.push(root)
  const entryPath = 'game/scene/start.txt'
  const entry = join(root, entryPath)
  await mkdir(join(root, 'game/scene'), { recursive: true })
  await writeFile(entry, 'say:原候选 -clear;')
  const originalDigest = await digestOf(entry)
  const controller = new AbortController()
  const budget = new ExecutionBudget({ modelAttempts: 4, toolCalls: 4, activeMs: 60_000 })
  const toolbox = new SceneCandidateToolbox({
    workspaceRoot: root,
    entryPath,
    authority: { files: new Set([entryPath]), inputs: new Map() },
    budget,
    signal: controller.signal,
    toolResultCharLimit: 8000
  })
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  fsGate.readFile = async () => {
    entered.resolve()
    await release.promise
  }
  const faux = fauxProvider()
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall('writeCandidate', {
        path: entryPath,
        expectedRevision: originalDigest,
        content: 'say:半成品 -clear;'
      }),
      { stopReason: 'toolUse' }
    )
  ])
  const progress: AgentProgressEvent[] = []
  const events: AgentStreamEvent[] = []
  const run = createExecutor(faux).run({
    systemPrompt: 'SYS',
    prompt: '生成候选',
    tools: toolbox.tools,
    signal: controller.signal,
    identity: { executionId: 'execution', agentId: 'webgal-scene', runId: 'run' },
    budget,
    progress: (event) => progress.push(event),
    observation: { subscriptions: [{ onEvent: (event) => events.push(event) }] },
    hooks: {
      finishTurn: async () => (toolbox.hasWritten ? ({ action: 'end' } as const) : undefined)
    }
  })

  await entered.promise
  controller.abort(new Error('写盘期间取消'))
  release.resolve()
  const result = await run

  expect(result.status).toBe('cancelled')
  expect(toolbox.hasWritten).toBe(false)
  expect(await digestOf(entry)).toBe(originalDigest)
  expect(await readFile(entry, 'utf8')).toBe('say:原候选 -clear;')
  expect(await readSceneDraft(root, entryPath)).toMatchObject({
    exists: true,
    revision: originalDigest
  })
  const toolStream = events.filter((event) => event.type === 'tool')
  expect(toolStream.at(-1)).toMatchObject({
    status: 'interrupted',
    toolName: 'writeCandidate'
  })
  expect(events.filter((event) => event.type === 'run').map((event) => event.status)).toEqual([
    'started',
    'cancelled'
  ])
})

it('写前追问工具只在允许时提供，应用分配稳定题号且与写入互斥', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-scene-questions-'))
  roots.push(root)
  const entryPath = 'game/scene/start.txt'
  const entry = join(root, entryPath)
  await mkdir(join(root, 'game/scene'), { recursive: true })
  await writeFile(entry, 'say:种子 -clear;')
  const budget = new ExecutionBudget({ modelAttempts: 8, toolCalls: 8, activeMs: 60_000 })
  const controller = new AbortController()
  const questions = [
    {
      prompt: '主角此刻最想确认什么？',
      detail: '影响开场独白',
      options: [
        { label: '确认对方还在', description: '保留等待感' },
        { label: '确认自己该离开', description: '推动告别' },
        { label: '确认时间已到', description: '收紧节奏' }
      ]
    },
    {
      prompt: '结尾停在哪个动作？',
      options: [
        { label: '推门离开', description: '留出下一步' },
        { label: '回头', description: '保留犹豫' },
        { label: '沉默', description: '收在静止画面' }
      ]
    }
  ]
  const allowed = new SceneCandidateToolbox({
    workspaceRoot: root,
    entryPath,
    authority: { files: new Set([entryPath]), inputs: new Map() },
    budget,
    signal: controller.signal,
    toolResultCharLimit: 8000,
    allowClarification: true
  })
  expect(allowed.tools.map((tool) => tool.name)).toContain('requestClarification')
  const ask = allowed.tools.find((tool) => tool.name === 'requestClarification')
  if (!ask) throw new Error('缺少提问工具')
  const asked = await ask.execute('call-ask', { questions }, controller.signal)
  expect(asked.details).toMatchObject({
    questions: [
      {
        questionId: 'q1',
        options: [{ id: 'q1o1', label: '确认对方还在' }, { id: 'q1o2' }, { id: 'q1o3' }]
      },
      { questionId: 'q2', options: [{ id: 'q2o1' }, { id: 'q2o2' }, { id: 'q2o3' }] }
    ]
  })
  expect(allowed.hasAsked).toBe(true)
  expect(allowed.hasWritten).toBe(false)
  const write = allowed.tools.find((tool) => tool.name === 'writeCandidate')
  if (!write) throw new Error('缺少写工具')
  const revision = await digestOf(entry)
  await expect(
    write.execute(
      'call-write',
      { path: entryPath, expectedRevision: revision, content: 'say:提问后写入 -clear;' },
      controller.signal
    )
  ).rejects.toThrow('本轮已经提出创作问题')
  expect(await readFile(entry, 'utf8')).toBe('say:种子 -clear;')

  const writeFirst = new SceneCandidateToolbox({
    workspaceRoot: root,
    entryPath,
    authority: { files: new Set([entryPath]), inputs: new Map() },
    budget,
    signal: controller.signal,
    toolResultCharLimit: 8000,
    allowClarification: true
  })
  const writeFirstTool = writeFirst.tools.find((tool) => tool.name === 'writeCandidate')!
  await writeFirstTool.execute(
    'call-write',
    { path: entryPath, expectedRevision: revision, content: 'say:先写后问 -clear;' },
    controller.signal
  )
  const askAfterWrite = writeFirst.tools.find((tool) => tool.name === 'requestClarification')!
  await expect(askAfterWrite.execute('call-ask', { questions }, controller.signal)).rejects.toThrow(
    '本轮已经写入候选'
  )

  const disallowed = new SceneCandidateToolbox({
    workspaceRoot: root,
    entryPath,
    authority: { files: new Set([entryPath]), inputs: new Map() },
    budget,
    signal: controller.signal,
    toolResultCharLimit: 8000
  })
  expect(disallowed.tools.map((tool) => tool.name)).not.toContain('requestClarification')
})

function createExecutor(faux: FauxProviderHandle): PiAgentExecutor {
  return new PiAgentExecutor({
    runtime: runtimeOf(faux),
    createAgent: (options) => new Agent(options)
  })
}

function runtimeOf(faux: FauxProviderHandle): PiModelRuntime {
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

async function digestOf(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}
