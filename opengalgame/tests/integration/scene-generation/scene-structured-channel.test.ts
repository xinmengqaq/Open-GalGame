import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

import type { SceneGenerationExecution } from '@application/scene-generation/models/SceneGenerationExecution'
import type { AgentExecution } from '@infrastructure/ai/agents/AgentExecution'
import { ExecutionBudget } from '@infrastructure/ai/execution/ExecutionBudget'
import { LangChainAgentFactoryImpl } from '@infrastructure/ai/factories/LangChainAgentFactoryImpl'
import { LangChainModelFactory } from '@infrastructure/ai/models/LangChainModelFactory'
import { FilePromptLoader } from '@infrastructure/ai/prompts/FilePromptLoader'
import { WebGalSceneAgentImpl } from '@infrastructure/scene-generation/agents/WebGalSceneAgentImpl'
import { boundedStructuredCorrection } from '@infrastructure/scene-generation/agents/sceneStructuredChannel'
import { streamingFetch } from '../ai/streamingFetch'

const roots: string[] = []
const script = 'game/scene/start.txt'
const validResult = {
  action: 'submit_scene_result',
  summary: '完成候选',
  writtenFiles: [script],
  usedAssetIds: [],
  unresolvedIssues: [],
  tradeoffs: [],
  questions: []
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('支持 json_schema 时请求 strict false，最终无工具 JSON 通过本地校验', async () => {
  const { bodies, output } = await runChannel([
    { kind: 'tool', name: 'writeText', args: { path: script, content: 'alpha' } },
    { kind: 'json', content: validResult }
  ])
  const sceneBodies = sceneRequests(bodies)
  expect(sceneBodies[0]?.response_format).toMatchObject({
    type: 'json_schema',
    json_schema: { strict: false }
  })
  expect(toolNames(sceneBodies[0]!)).not.toEqual(expect.arrayContaining([expect.stringMatching(/^extract-/)]))
  expect(output.writtenFiles).toEqual([script])
})

it('只支持 json_object 时实际请求对象模式并拒绝非法 JSON', async () => {
  const model = `json-object-${crypto.randomUUID()}`
  const { bodies } = await runChannel(
    [
      { kind: 'reject', format: 'json_schema' },
      { kind: 'tool', name: 'writeText', args: { path: script, content: 'alpha' } },
      { kind: 'json', content: validResult }
    ],
    model
  )
  const sceneBodies = sceneRequests(bodies)
  expect(sceneBodies[0]?.response_format).toMatchObject({ type: 'json_schema' })
  expect(sceneBodies.at(-1)?.response_format).toEqual({ type: 'json_object' })
  await expect(
    runChannel(
      [
        { kind: 'tool', name: 'writeText', args: { path: script, content: 'alpha' } },
        { kind: 'json', content: { summary: '缺字段' } }
      ],
      model
    )
  ).rejects.toMatchObject({ diagnosticCategory: 'structured-output' })
})

it('两种原生格式都不支持时调用固定工具并返回精确字段路径', async () => {
  const model = `tool-fallback-${crypto.randomUUID()}`
  const { bodies, output } = await runChannel(
    [
      { kind: 'reject', format: 'json_schema' },
      { kind: 'reject', format: 'json_object' },
      { kind: 'tool', name: 'writeText', args: { path: script, content: 'alpha' } },
      {
        kind: 'tool',
        name: 'submit_scene_result',
        args: { ...validResult, questions: [{ prompt: '选哪句？', options: [] }] }
      },
      { kind: 'tool', name: 'submit_scene_result', args: validResult }
    ],
    model
  )
  const sceneBodies = sceneRequests(bodies)
  const submitted = sceneBodies.filter((body) => toolNames(body).includes('submit_scene_result'))
  expect(submitted.length).toBeGreaterThan(0)
  expect(JSON.stringify(submitted[0]?.messages)).toContain('submit_scene_result')
  expect(output.summary).toBe('完成候选')
  const correction = boundedStructuredCorrection({
    toolCall: {
      args: {
        ...validResult,
        questions: [{ prompt: '选哪句？', options: [{ label: '甲', description: '第一项' }, { label: '乙', description: '第二项' }] }]
      }
    }
  })
  expect(correction).toContain('questions.0.options')
  expect(correction).not.toContain('选哪句')
})

type Step =
  | { kind: 'tool'; name: string; args: Record<string, unknown> }
  | { kind: 'json'; content: unknown }
  | { kind: 'reject'; format: 'json_schema' | 'json_object' }

async function runChannel(plan: readonly Step[], model = 'chosen'): Promise<{
  bodies: Array<Record<string, unknown>>
  output: { writtenFiles: readonly string[]; summary: string }
}> {
  const workspace = await mkdtemp(join(tmpdir(), 'scene-structured-'))
  roots.push(workspace)
  await mkdir(join(workspace, 'game/scene'), { recursive: true })
  const bodies: Array<Record<string, unknown>> = []
  let step = 0
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    bodies.push(body)
    if (JSON.stringify(body.messages).includes('Context Extraction Assistant')) {
      return Response.json(completion('摘要'))
    }
    const format = responseFormatType(body)
    const names = toolNames(body)


    const rejection = plan.find((item) => item.kind === 'reject' && item.format === format)
    if (rejection && bodies.filter((item) => responseFormatType(item) === format).length === 1) {
      return Response.json(
        { error: { message: `${format} is not supported`, type: 'invalid_request_error' } },
        { status: 400 }
      )
    }
    const serialized = JSON.stringify(body.messages)
    const wrote = serialized.includes('"name":"writeText"')
    if (!wrote && names.includes('writeText')) {
      const write = plan.find((item) => item.kind === 'tool' && item.name === 'writeText')
      return Response.json(toolCompletion('writeText', write?.kind === 'tool' ? write.args : {}, bodies.length))
    }
    const submit = [...plan].reverse().find((item) => item.kind === 'tool' && item.name === 'submit_scene_result' && item.args.summary === '完成候选')
    const invalidSubmit = plan.find((item) => item.kind === 'tool' && item.name === 'submit_scene_result' && item.args.summary !== '完成候选')
    if (names.includes('submit_scene_result')) {
      const selected = bodies.filter((item) => toolNames(item).includes('submit_scene_result')).length === 1 && invalidSubmit?.kind === 'tool'
        ? invalidSubmit
        : submit
      return Response.json(toolCompletion('submit_scene_result', selected?.kind === 'tool' ? selected.args : {}, bodies.length))
    }
    const json = [...plan].reverse().find((item) => item.kind === 'json')
    return Response.json(completion(JSON.stringify(json?.kind === 'json' ? json.content : {})))
  })
  vi.stubEnv('OPENAI_API_KEY', 'ambient-openai-key')
  const factory = new LangChainAgentFactoryImpl(
    new LangChainModelFactory(
      async () => ({
        providerId: 'openai-compatible',
        baseUrl: 'https://service.example/v1',
        model,
        contextWindow: 24000,
        maxOutputTokens: 400,
        apiKey: 'stored-secret'
      }),
      streamingFetch(fetcher)
    ),
    new FilePromptLoader(resolve('resources/ai/prompts'))
  )
  const agent = await factory.create(WebGalSceneAgentImpl, {
    override: { technicalRetryCount: 0, contextInputBudgetTokens: 20000 }
  })
  try {
    const output = await agent.invoke(sceneInput(), execution(workspace))
    return { bodies, output }
  } finally {
    vi.unstubAllEnvs()
  }
}

function sceneRequests(bodies: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return bodies.filter((body) => !JSON.stringify(body.messages).includes('Context Extraction Assistant'))
}

function toolNames(body: Record<string, unknown>): string[] {
  const tools = body.tools
  if (!Array.isArray(tools)) return []
  return tools.flatMap((tool) =>
    tool && typeof tool === 'object' && 'function' in tool && tool.function &&
    typeof tool.function === 'object' && 'name' in tool.function &&
    typeof tool.function.name === 'string'
      ? [tool.function.name]
      : []
  )
}

function latestMessageText(body: Record<string, unknown>): string {
  const messages = body.messages
  if (!Array.isArray(messages)) return ''
  const latest = messages.at(-1)
  if (!latest || typeof latest !== 'object' || !('content' in latest)) return ''
  return typeof latest.content === 'string' ? latest.content : JSON.stringify(latest.content)
}


function responseFormatType(body: Record<string, unknown>): string | undefined {
  const format = body.response_format
  return format && typeof format === 'object' && 'type' in format && typeof format.type === 'string'
    ? format.type
    : undefined
}

function completion(content: string): Record<string, unknown> {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 1,
    model: 'chosen',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }]
  }
}

function toolCompletion(name: string, args: Record<string, unknown>, turn: number): Record<string, unknown> {
  return {
    id: `chatcmpl-${turn}`,
    object: 'chat.completion',
    created: 1,
    model: 'chosen',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: `call-${turn}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }]
      },
      finish_reason: 'tool_calls'
    }]
  }
}

function sceneInput(): Parameters<WebGalSceneAgentImpl['invoke']>[0] {
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
      prompts: [{ id: 'story', title: '道别', body: '写一句道别。', scopes: [{ kind: 'scene' as const }], usage: { targetIds: [] } }],
      fieldBindings: [],
      relations: [],
      confirmedControls: []
    },
    policy: { maxCorrections: 2 },
    reviewCandidate: true,
    baseline: { commitId: 'base', affectedFiles: [], lockState: 'unlocked' as const },
    state: 'running' as const,
    step: 'generating' as const,
    attempt: 0,
    sequence: 0,
    budget: { correctionsUsed: 0, modelCallsUsed: 0, toolCallsUsed: 0, activeElapsedMs: 0 },
    replies: []
  } satisfies SceneGenerationExecution
  return { mode: 'generate', execution: executionFact }
}

function execution(workspace: string): AgentExecution {
  return {
    identity: { executionId: 'structured-run' },
    scope: { threadId: 'structured-thread' },
    context: {
      budget: new ExecutionBudget({ modelAttempts: 16, toolCalls: 16, activeMs: 900000 }),
      requiredMessageIds: ['webgal-current-facts'],
      workspace: { root: workspace, writable: true, writablePaths: [script] }
    }
  }
}

