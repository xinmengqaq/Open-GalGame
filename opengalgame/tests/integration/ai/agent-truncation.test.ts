import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

import type { SceneGenerationExecution } from '@application/scene-generation/models/SceneGenerationExecution'
import type { AgentExecution } from '@infrastructure/ai/agents/AgentExecution'
import { ExecutionBudget } from '@infrastructure/ai/execution/ExecutionBudget'
import { LangChainAgentFactoryImpl } from '@infrastructure/ai/factories/LangChainAgentFactoryImpl'
import { LangChainModelFactory } from '@infrastructure/ai/models/LangChainModelFactory'
import { FilePromptLoader } from '@infrastructure/ai/prompts/FilePromptLoader'
import { countsAsErrorAttempt, normalizeAgentError } from '@infrastructure/ai/middleware/retryPolicy'

import { WebGalSceneAgentImpl } from '@infrastructure/scene-generation/agents/WebGalSceneAgentImpl'

import { streamingFetch } from './streamingFetch'

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
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('finish_reason 为 length 时按输出截断停止，用量已计入且不再调用模型或工具', async () => {
  const observed = await runTruncation(
    [{ kind: 'reject', format: 'json_schema' }, { kind: 'reject', format: 'json_object' }, { kind: 'write' }, { kind: 'truncated', signal: 'length' }],
    'length'
  )
  expect(observed.error).toMatchObject({
    code: 4101,
    message: '模型输出达到长度上限，本次生成未完成',
    diagnosticCategory: 'output-truncated'
  })
  expect(observed.budget.errorAttempts).toBe(0)
  expect(observed.budget.usage.modelAttempts).toBe(4)
  expect(observed.budget.usage.tokens).toBeGreaterThan(0)
  expect(observed.fetcher).toHaveBeenCalledTimes(4)
  expect(observed.toolNames).toEqual(['writeText'])
  expect(await readdir(join(observed.workspace, 'game/scene'))).toEqual(['start.txt'])
})

it('Anthropic 兼容响应的 stop_reason 为 max_tokens 时按输出截断停止且不消耗错误预算', async () => {
  const observed = await runTruncation(
    [{ kind: 'reject', format: 'json_schema' }, { kind: 'reject', format: 'json_object' }, { kind: 'truncated', signal: 'max_tokens', content: '未写完' }],
    'max-tokens'
  )
  expect(observed.error).toMatchObject({
    code: 4101,
    diagnosticCategory: 'output-truncated'
  })
  expect(observed.budget.errorAttempts).toBe(0)
  expect(observed.fetcher).toHaveBeenCalledTimes(3)
  expect(observed.toolNames).toEqual([])
  expect(await readdir(join(observed.workspace, 'game/scene'))).toEqual([])
})

it('正文里的 invalid_tool_call 不进入工具执行', async () => {
  const observed = await runTruncation(
    [
      { kind: 'reject', format: 'json_schema' },
      { kind: 'reject', format: 'json_object' },
      {
        kind: 'truncated',
        signal: 'content',
        content: [
          { type: 'text', text: '准备写入' },
          { type: 'invalid_tool_call', name: 'writeText', args: '{"path":"game/scene/start.txt"' }
        ]
      }
    ],
    'content'
  )
  expect(observed.error).toMatchObject({ diagnosticCategory: 'output-truncated' })
  expect(observed.fetcher).toHaveBeenCalledTimes(3)
  expect(observed.toolNames).toEqual([])
  expect(await readdir(join(observed.workspace, 'game/scene'))).toEqual([])
})

it('无法解析的工具参数进入 invalid_tool_calls 后按截断停止且不重试', async () => {
  const observed = await runTruncation(
    [{ kind: 'reject', format: 'json_schema' }, { kind: 'reject', format: 'json_object' }, { kind: 'truncated', signal: 'invalid_tool_calls' }],
    'invalid'
  )
  expect(observed.error).toMatchObject({
    name: 'OutputTruncated',
    diagnosticCategory: 'output-truncated'
  })
  expect(countsAsErrorAttempt(observed.error)).toBe(false)
  expect(normalizeAgentError(observed.error)).toBe(observed.error)
  expect(observed.fetcher).toHaveBeenCalledTimes(3)
  expect(observed.toolNames).toEqual([])
})

it('没有截断信号也没有结构化结果时归为缺失结构化结果', async () => {
  const observed = await runTruncation([{ kind: 'reject', format: 'json_schema' }, { kind: 'reject', format: 'json_object' }, { kind: 'plain', content: '只返回了正文' }], 'missing')
  expect(observed.error).toMatchObject({
    code: 4101,
    message: '模型没有提交结构化结果',
    diagnosticCategory: 'missing-structured-result'
  })
  expect(observed.budget.errorAttempts).toBe(0)
  expect(observed.fetcher).toHaveBeenCalledTimes(3)
})

it('提交了对象但字段不合法时仍是结构化输出错误', async () => {
  const observed = await runTruncation(
    [{ kind: 'reject', format: 'json_schema' }, { kind: 'write' }, { kind: 'json', content: { summary: '缺字段' } }],
    'schema'
  )
  expect(observed.error).toMatchObject({
    code: 4101,
    message: '模型输出不符合约定',
    diagnosticCategory: 'structured-output'
  })
  expect(observed.budget.errorAttempts).toBe(0)
})

it('写后两轮内的合法提交仍结束，截断分类不改变写后窗口', async () => {
  const observed = await runTruncation(
    [
      { kind: 'reject', format: 'json_schema' },
      { kind: 'reject', format: 'json_object' },
      { kind: 'write' },
      { kind: 'plain', content: '先核对候选' },
      { kind: 'plain', content: '再核对候选' },
      { kind: 'json', content: validResult }
    ],
    'window'
  )
  expect(observed.error).toBeUndefined()
  expect(observed.output?.writtenFiles).toEqual([script])
  expect(observed.output?.summary).toBe('完成候选')
  expect(observed.budget.errorAttempts).toBe(0)
})

type Step =
  | { kind: 'reject'; format: 'json_schema' | 'json_object' }
  | { kind: 'write' }
  | { kind: 'plain'; content: string }
  | { kind: 'json'; content: unknown }
  | {
      kind: 'truncated'
      signal: 'length' | 'max_tokens' | 'content' | 'invalid_tool_calls'
      content?: unknown
    }

interface TruncationObservation {
  error?: { code?: number; message?: string; diagnosticCategory?: string; name?: string }
  output?: { writtenFiles: readonly string[]; summary: string }
  budget: ExecutionBudget
  fetcher: ReturnType<typeof vi.fn>
  toolNames: string[]
  workspace: string
}

async function runTruncation(plan: readonly Step[], modelKey: string): Promise<TruncationObservation> {
  const workspace = await mkdtemp(join(tmpdir(), 'agent-truncation-'))
  roots.push(workspace)
  await mkdir(join(workspace, 'game/scene'), { recursive: true })
  const budget = new ExecutionBudget({ modelAttempts: 16, toolCalls: 16, activeMs: 900000 })
  const toolNames: string[] = []
  let step = 0
  const bodies: Array<Record<string, unknown>> = []
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    bodies.push(body)
    if (JSON.stringify(body.messages).includes('Context Extraction Assistant')) {
      return Response.json(completion('摘要'))
    }
    const format = responseFormatType(body)
    if (plan.some((item) => item.kind === 'reject' && item.format === format)) {
      return Response.json(
        { error: { message: `${format} is not supported`, type: 'invalid_request_error' } },
        { status: 400 }
      )
    }
    const names = requestToolNames(body)
    const serialized = JSON.stringify(body.messages)
    const wrote = serialized.includes('"name":"writeText"')
    const actionable = plan.filter((item) => item.kind !== 'reject')
    if (!wrote && names.includes('writeText') && actionable.some((item) => item.kind === 'write')) {
      toolNames.push('writeText')
      return Response.json(toolCompletion('writeText', { path: script, content: 'alpha' }, bodies.length))
    }
    const truncated = actionable.find((item) => item.kind === 'truncated')
    if (truncated?.kind === 'truncated' && step === 0 && !actionable.some((item) => item.kind === 'json')) {
      step += 1
      return Response.json(truncatedCompletion(truncated, bodies.length))
    }
    if (names.includes('submit_scene_result')) {
      const submitted = actionable.filter((item) => item.kind === 'json')
      const selected = submitted[Math.min(step, submitted.length - 1)]
      step += 1
      if (selected?.kind === 'json') {
        return Response.json(toolCompletion('submit_scene_result', selected.content as Record<string, unknown>, step))
      }
    }
    const plain = actionable.find((item) => item.kind === 'plain')
    const json = [...actionable].reverse().find((item) => item.kind === 'json')
    if (json?.kind === 'json' && !names.includes('submit_scene_result')) {
      return Response.json(completion(JSON.stringify(json.content)))
    }
    return Response.json(completion(plain?.kind === 'plain' ? plain.content : '继续'))
  })
  vi.stubEnv('OPENAI_API_KEY', 'ambient-openai-key')
  const factory = new LangChainAgentFactoryImpl(
    new LangChainModelFactory(
      async () => ({
        providerId: 'openai-compatible',
        baseUrl: 'https://service.example/v1',
        model: `truncation-${modelKey}`,
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
    const output = await agent.invoke(sceneInput(), execution(workspace, budget))
    return { output, budget, fetcher, toolNames, workspace }
  } catch (error) {
    return {
      error: error as { code?: number; message?: string; diagnosticCategory?: string; name?: string },
      budget,
      fetcher,
      toolNames,
      workspace
    }
  }
}

function truncatedCompletion(
  step: Extract<Step, { kind: 'truncated' }>,
  turn: number
): Record<string, unknown> {
  const finishReason = step.signal === 'max_tokens' || step.signal === 'length' ? 'length' : 'stop'
  const content = step.signal === 'content' ? null : (step.content ?? '输出未完成')
  const invalid = step.signal === 'content' || step.signal === 'invalid_tool_calls'
  return {
    id: `chatcmpl-${turn}`,
    object: 'chat.completion',
    created: 1,
    model: 'chosen',
    ...(step.signal === 'max_tokens' ? { stop_reason: 'max_tokens' } : {}),
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
          ...(invalid
            ? {
                tool_calls: [
                  {
                    id: `call-${turn}`,
                    type: 'function',
                    function: { name: 'writeText', arguments: '{"path":"game/scene/start.txt"' }
                  }
                ]
              }
            : {})
        },
        finish_reason: finishReason
      }
    ],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }
  }
}

function completion(content: string): Record<string, unknown> {
  return {
    id: 'chatcmpl-plain',
    object: 'chat.completion',
    created: 1,
    model: 'chosen',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }
  }
}

function responseFormatType(body: Record<string, unknown>): string | undefined {
  const format = body.response_format
  return format && typeof format === 'object' && 'type' in format && typeof format.type === 'string'
    ? format.type
    : undefined
}

function requestToolNames(body: Record<string, unknown>): string[] {
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

function toolCompletion(name: string, args: Record<string, unknown>, turn: number): Record<string, unknown> {
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
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }
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
    reviewCandidate: true,
    baseline: { commitId: 'base', affectedFiles: [], lockState: 'unlocked' as const },
    state: 'running' as const,
    phase: 'generating' as const,
    attempt: 0,
    sequence: 0,
    budget: { correctionsUsed: 0, modelCallsUsed: 0, toolCallsUsed: 0, activeElapsedMs: 0 },
    replies: []
  } satisfies SceneGenerationExecution
  return { mode: 'generate', execution: executionFact }
}

function execution(workspace: string, budget: ExecutionBudget): AgentExecution {
  return {
    identity: { executionId: 'truncation-run' },
    scope: { threadId: 'truncation-thread' },
    context: {
      budget,
      requiredMessageIds: ['webgal-current-facts'],
      workspace: { root: workspace, writable: true, writablePaths: [script] }
    }
  }
}
