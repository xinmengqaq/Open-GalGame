import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

import type { SceneGenerationExecution } from '@application/scene-generation/models/SceneGenerationExecution'
import type { AgentExecution } from '@infrastructure/ai/agents/AgentExecution'
import { estimateTokens } from '@infrastructure/ai/context/contextBudget'
import { ExecutionBudget } from '@infrastructure/ai/execution/ExecutionBudget'
import { writtenFileFacts } from '@infrastructure/ai/execution/writtenFileLedger'
import { LangChainAgentFactoryImpl } from '@infrastructure/ai/factories/LangChainAgentFactoryImpl'
import { LangChainModelFactory } from '@infrastructure/ai/models/LangChainModelFactory'
import { FilePromptLoader } from '@infrastructure/ai/prompts/FilePromptLoader'
import { WebGalSceneAgentImpl } from '@infrastructure/scene-generation/agents/WebGalSceneAgentImpl'
import { streamingFetch } from '../ai/streamingFetch'
import {
  generationFixture,
  request,
  validScript
} from '../../../../harness/acceptance/support/generationFixture'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('每轮请求都带运行状态，写出后带当前候选和版本', async () => {
  const f = await generationFixture({ postWriteResponses: 1 })
  await f.app.generation.generateScene(request)
  await f.run()
  const writeIndex = f.bodies.findIndex((body) => requestedTool(body, 'writeText'))
  expect(writeIndex).toBeGreaterThanOrEqual(0)
  for (const body of f.bodies.slice(0, writeIndex).filter((item) => !isSummary(item)))
    expect(systemText(body)).toContain('候选：未写出')
  const afterWrite = f.bodies.slice(writeIndex).filter((body) => !isSummary(body))
  expect(afterWrite.length).toBeGreaterThan(0)
  for (const body of afterWrite) {
    const block = progressBlock(systemText(body))
    expect(block).toContain(`game/scene/start.txt（${Buffer.byteLength(validScript)} bytes，版本 `)
    expect(block).toContain('阶段：撰写候选')
    expect(block).toContain('下一步：提交或报告阻塞：无提交工具时直接输出 JSON')
    expect(estimateTokens(block)).toBeLessThanOrEqual(200)
    expect(nonSystemText(body)).not.toContain('[运行状态]')
  }
})

it('多个已写文件仍只发一条当前候选，后续改动不改已确认大小', async () => {
  const extraPaths = Array.from({ length: 6 }, (_, index) => `game/scene/note-${index}.txt`)
  const observed = await runObserved([
    { name: 'writeText', args: { path: 'game/scene/start.txt', content: validScript } },
    ...extraPaths.map((path) => ({
      name: 'writeText',
      args: { path, content: '候选说明'.repeat(80) }
    }))
  ])
  await writeFile(join(observed.workspace, extraPaths[0]!), 'touched-after-write')
  const progressed = observed.bodies.filter((body) => systemText(body).includes('[运行状态]'))
  expect(progressed.length).toBeGreaterThan(0)
  for (const body of progressed)
    expect(estimateTokens(progressBlock(systemText(body)))).toBeLessThanOrEqual(200)
  const block = progressBlock(systemText(progressed.at(-1)!))
  expect(block).toMatch(/候选：game\/scene\/note-\d\.txt/u)
  expect(block).not.toContain('touched-after-write')
  expect(block).not.toContain('game/scene/start.txt')
  expect(block).toContain('阶段：撰写候选')
  expect(nonSystemText(progressed.at(-1)!)).not.toContain('[运行状态]')
  expect(observed.memory.every((content) => !content.includes('[运行状态]'))).toBe(true)
})

it('上下文裁剪后的同一次请求仍含运行状态，且不进入长期记忆', async () => {
  const observed = await runObserved(
    [
      { name: 'writeText', args: { path: 'game/scene/start.txt', content: validScript } },
      {
        name: 'readTextRange',
        args: { path: 'game/scene/start.txt', start: 0, maxChars: 5000 }
      }
    ],
    {
      contextInputBudgetTokens: 14000,
      memoryMessages: [
        { id: 'old-long', role: 'user', content: '过去的车站创作讨论。'.repeat(12000) },
        { id: 'old-answer', role: 'assistant', content: '旧轮次结束。' },
        { id: 'later', role: 'user', content: '继续当前场景。' }
      ]
    }
  )
  const writeIndex = observed.bodies.findIndex((body) => requestedTool(body, 'writeText'))
  const trimmed = observed.bodies
    .slice(writeIndex + 1)
    .filter(
      (body) =>
        !nonSystemText(body).includes('过去的车站创作讨论') &&
        systemText(body).includes('[运行状态]')
    )
  expect(observed.bodies.some((body) => isSummary(body))).toBe(true)
  expect(trimmed.length).toBeGreaterThan(0)
  for (const body of trimmed) {
    const text = systemText(body)
    expect(text).toContain(`game/scene/start.txt（${Buffer.byteLength(validScript)} bytes`)
    expect(text).toContain('阶段：撰写候选')
    expect(estimateTokens(progressBlock(text))).toBeLessThanOrEqual(200)
    expect(nonSystemText(body)).not.toContain('[运行状态]')
  }
  expect(observed.memory.every((content) => !content.includes('[运行状态]'))).toBe(true)
  expect(observed.memory.every((content) => !content.includes('过去的车站创作讨论'))).toBe(true)
})

it('错误版本只列出路径，不伪造文件大小', async () => {
  const observed = await runObserved(
    [
      { name: 'writeText', args: { path: 'game/scene/start.txt', content: validScript } },
      {
        name: 'readTextRange',
        args: { path: 'game/scene/start.txt', start: 0, maxChars: 5000 }
      }
    ],
    {
      beforeResponse: (run) => {
        const facts = writtenFileFacts(run.context.budget) as Array<{
          path: string
          version: string
        }>
        const latest = facts.at(-1)
        if (latest?.version.includes(':'))
          facts[facts.length - 1] = { path: latest.path, version: 'unknown' }
      }
    }
  )
  const progressed = observed.bodies.filter((body) => systemText(body).includes('[运行状态]'))
  expect(progressed.length).toBeGreaterThan(0)
  const block = progressBlock(systemText(progressed.at(-1)!))
  expect(block).toContain('game/scene/start.txt')
  expect(block).not.toContain('bytes')
})

it('已有权威候选时收尾与修正状态块列出路径，本轮新写入只补充版本', async () => {
  const entry = 'game/scene/start.txt'
  for (const mode of ['finalize', 'repair'] as const) {
    const observed = await runObserved(
      mode === 'repair' ? [{ name: 'writeText', args: { path: entry, content: validScript } }] : [],
      { mode, writtenFiles: [entry] }
    )
    const blocks = observed.bodies
      .map((body) => systemText(body))
      .filter((text) => text.includes('[运行状态]'))
      .map(progressBlock)
    const first = blocks[0]!
    expect(first).toContain(`候选：${entry}`)
    expect(first).not.toContain('候选：未写出')
    expect(first).not.toContain('bytes')
    expect(first).toContain(mode === 'finalize' ? '阶段：收尾提交' : '阶段：撰写候选')
    if (mode === 'repair') {
      expect(first).toContain('本轮尚未写入：先改写候选')
      expect(first).not.toContain('submit_scene_result')
      expect(blocks.length).toBeGreaterThan(1)
      const afterWrite = blocks.find((block) => block.includes(`候选：${entry}（`))
      expect(afterWrite).toBeDefined()
      expect(afterWrite).toContain(`${Buffer.byteLength(validScript)} bytes`)
      expect(afterWrite).toContain('提交或报告阻塞：无提交工具时直接输出 JSON')
    } else {
      expect(first).toContain('提交或报告阻塞：无提交工具时直接输出 JSON')
    }
  }
})

async function runObserved(
  plan: ReadonlyArray<{ name: string; args: Record<string, unknown> }>,
  options: {
    contextInputBudgetTokens?: number
    mode?: 'generate' | 'repair' | 'finalize'
    writtenFiles?: readonly string[]
    memoryMessages?: ReadonlyArray<{ id: string; role: 'user' | 'assistant'; content: string }>
    beforeResponse?: (execution: AgentExecution) => void
  } = {}
): Promise<{ workspace: string; bodies: RequestBody[]; memory: string[] }> {
  const workspace = await mkdtemp(join(tmpdir(), 'progress-ledger-'))
  roots.push(workspace)
  await mkdir(join(workspace, 'game/scene'), { recursive: true })
  await writeFile(join(workspace, 'game/scene/start.txt'), 'origin')
  const run = execution(workspace, plan, options.writtenFiles)
  const bodies: RequestBody[] = []
  let step = 0
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as RequestBody
    bodies.push(body)
    options.beforeResponse?.(run)
    if (isSummary(body)) return Response.json(textMessage('摘要'))
    const planned =
      step < plan.length
        ? plan[step]!
        : {
            name: 'structured',
            args: {
              action: 'submit_scene_result',
              summary: '候选已写出',
              writtenFiles: [
                ...new Set([
                  ...plan.flatMap((item) =>
                    typeof item.args.path === 'string' ? [item.args.path] : []
                  ),
                  'game/scene/start.txt'
                ])
              ],
              usedAssetIds: [],
              unresolvedIssues: [],
              tradeoffs: [],
              questions: []
            }
          }
    step += 1
    const name = planned.name === 'structured' ? structuredName(body) : planned.name
    return Response.json(toolMessage(name, planned.args, step))
  })
  vi.stubEnv('OPENAI_API_KEY', 'ambient-openai-key')
  const factory = new LangChainAgentFactoryImpl(
    new LangChainModelFactory(
      async () => ({
        providerId: 'openai-compatible',
        baseUrl: 'https://service.example/v1',
        model: 'chosen',
        contextWindow: 128000,
        maxOutputTokens: 400,
        apiKey: 'stored-secret'
      }),
      streamingFetch(fetcher)
    ),
    new FilePromptLoader(resolve('resources/ai/prompts'))
  )
  const agent = await factory.create(WebGalSceneAgentImpl, {
    override: {
      technicalRetryCount: 0,
      contextInputBudgetTokens: options.contextInputBudgetTokens ?? 24000
    }
  })
  try {
    const output = await agent.invoke(sceneInput(options), run)
    return { workspace, bodies, memory: output.memoryMessages.map((message) => message.content) }
  } catch (error) {
    if (bodies.some((body) => systemText(body).includes('[运行状态]'))) {
      return { workspace, bodies, memory: [] }
    }
    throw error
  } finally {
    vi.unstubAllEnvs()
  }
}

function sceneInput(
  options: {
    mode?: 'generate' | 'repair' | 'finalize'
    writtenFiles?: readonly string[]
    memoryMessages?: ReadonlyArray<{ id: string; role: 'user' | 'assistant'; content: string }>
  } = {}
) {
  const memoryMessages = options.memoryMessages ?? [
    { id: 'history', role: 'user', content: '已有讨论' }
  ]
  const executionFact = {
    projectId: 'project-1',
    sceneId: 'scene-1',
    operationId: 'operation-1',
    threadId: 'thread-1',
    branchId: 'branch-1',
    fingerprint: 'fingerprint',
    source: {
      projectId: 'project-1',
      sceneId: 'scene-1',
      projectRoot: 'project',
      sceneDirectory: 'game/scene',
      entryFile: 'start.txt'
    },
    inputSnapshot: {
      canvasId: 'canvas-1',
      arrangementVersion: 'arrangement-1',
      assets: [],
      documents: [],
      prompts: [
        {
          id: 'story',
          title: '道别',
          body: '写一句道别。',
          scopes: [{ kind: 'scene' as const }],
          usage: { targetIds: [] }
        }
      ],
      fieldBindings: [],
      relations: [],
      confirmedControls: []
    },
    policy: { maxCorrections: 2 },
    reviewCandidate: false,
    baseline: { commitId: 'baseline', lockState: 'unlocked' as const },
    state: 'running' as const,
    phase: 'generating' as const,
    attempt: 0,
    sequence: 0,
    budget: { correctionsUsed: 0, modelCallsUsed: 0, toolCallsUsed: 0, activeElapsedMs: 0 },
    replies: []
  } satisfies SceneGenerationExecution
  return {
    mode: options.mode ?? ('generate' as const),
    execution: executionFact,
    ...(options.writtenFiles !== undefined ? { writtenFiles: options.writtenFiles } : {}),
    memoryMessages
  }
}

function execution(
  workspace: string,
  plan: ReadonlyArray<{ args: Record<string, unknown> }>,
  writtenFiles?: readonly string[]
): AgentExecution {
  const writablePaths = plan.flatMap((item) =>
    typeof item.args.path === 'string' ? [item.args.path] : []
  )
  return {
    identity: { executionId: 'progress-ledger-run' },
    scope: { threadId: 'progress-ledger-thread' },
    context: {
      budget: new ExecutionBudget({ modelAttempts: 16, toolCalls: 16, activeMs: 900000 }),
      workspace: { root: workspace, writable: true, writablePaths },
      ...(writtenFiles !== undefined ? { writtenFiles } : {})
    }
  }
}

function structuredName(body: RequestBody): string {
  const name = body.tools.find(
    (tool) =>
      !['read_file', 'writeText', 'replaceText', 'readTextRange', 'listDirectory'].includes(
        tool.function.name
      )
  )?.function.name
  if (!name) throw new Error('请求没有结构化工具')
  return name
}

function requestedTool(body: RequestBody, name: string): boolean {
  return body.messages.some(
    (message) =>
      message.role === 'assistant' &&
      (message.tool_calls ?? []).some((call) => call.function?.name === name)
  )
}

function isSummary(body: RequestBody): boolean {
  return JSON.stringify(body).includes('Context Extraction Assistant')
}

function systemText(body: RequestBody): string {
  return body.messages
    .filter((message) => message.role === 'system')
    .map((message) => requestText(message.content))
    .join('\n')
}

function nonSystemText(body: RequestBody): string {
  return body.messages
    .filter((message) => message.role !== 'system')
    .map((message) => requestText(message.content))
    .join('\n')
}

function requestText(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content)
}

function progressBlock(text: string): string {
  const start = text.indexOf('[运行状态]')
  if (start < 0) throw new Error('请求没有运行状态')
  const rest = text.slice(start)
  const nextBlock = rest.search(/"\},\{/u)
  return nextBlock < 0 ? rest : rest.slice(0, nextBlock)
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
    ],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
  }
}

type RequestBody = {
  messages: Array<{
    role: string
    content?: unknown
    tool_calls?: Array<{ function?: { name?: string } }>
  }>
  tools: Array<{ function: { name: string } }>
}
