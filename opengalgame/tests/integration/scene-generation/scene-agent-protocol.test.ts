import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
import { streamingFetch } from '../ai/streamingFetch'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('写入后仍可回读并修订同一脚本，同文件多次写入按集合形成候选', async () => {
  const script = 'game/scene/start.txt'
  const { output, choices, workspace } = await runScene([
    { name: 'writeText', args: { path: script, content: 'alpha' } },
    { name: 'readTextRange', args: { path: script, start: 0, maxChars: 20 } },
    {
      name: 'replaceText',
      args: { path: script, oldText: 'alpha', newText: 'beta', expectedMatches: 1 }
    },
    {
      name: 'structured',
      args: {
        action: 'submit_scene_result',
        summary: '修订同一脚本',
        writtenFiles: [script],
        usedAssetIds: [],
        unresolvedIssues: [],
        tradeoffs: [],
        questions: []
      }
    }
  ])

  expect(choices.every((choice) => choice === '')).toBe(true)
  expect(output.writtenFiles).toEqual([script])
  expect(await readFile(join(workspace, script), 'utf8')).toBe('beta')
})

it('声明与实际写入集合不一致时拒绝候选，失败写入不能充当成功', async () => {
  const script = 'game/scene/start.txt'
  await expect(
    runScene([
      { name: 'writeText', args: { path: script, content: 'alpha' } },
      {
        name: 'structured',
        args: {
          action: 'submit_scene_result',
          summary: '多报文件',
          writtenFiles: [script, 'game/scene/other.txt'],
          usedAssetIds: [],
          unresolvedIssues: [],
          tradeoffs: [],
          questions: []
        }
      }
    ])
  ).rejects.toThrow('智能体完成结果与实际候选脚本写入不一致')

  await expect(
    runScene([
      {
        name: 'replaceText',
        args: { path: script, oldText: 'missing', newText: 'beta', expectedMatches: 1 }
      },
      {
        name: 'structured',
        args: {
          action: 'submit_scene_result',
          summary: '失败写入',
          writtenFiles: [script],
          usedAssetIds: [],
          unresolvedIssues: [],
          tradeoffs: [],
          questions: []
        }
      }
    ])
  ).rejects.toThrow('智能体未通过文件工具实际写入候选脚本')
})

it('未写文件时请求澄清直接返回问题，不当作完成失败', async () => {
  const { output } = await runScene(
    [
      {
        name: 'json',
        args: {
          action: 'request_clarification',
          summary: '需要用户决定',
          writtenFiles: [],
          usedAssetIds: [],
          unresolvedIssues: [],
          tradeoffs: [],
          questions: [clarificationQuestion('告别后去哪里？')]
        }
      }
    ],
    undefined,
    { contextWindow: 32000, contextInputBudgetTokens: 20000 }
  )
  expect(output.action).toBe('request_clarification')
  expect(output.writtenFiles).toEqual([])
  expect(output.questions[0]?.prompt).toBe('告别后去哪里？')
})

it('未写文件就提交候选时按完成契约拒绝', async () => {
  await expect(
    runScene(
      [
        {
          name: 'json',
          args: {
            action: 'submit_scene_result',
            summary: '空提交',
            writtenFiles: [],
            usedAssetIds: [],
            unresolvedIssues: [],
            tradeoffs: [],
            questions: []
          }
        }
      ],
      undefined,
      { contextWindow: 32000, contextInputBudgetTokens: 20000 }
    )
  ).rejects.toMatchObject({
    code: 4103,
    message: '智能体未通过文件工具实际写入候选脚本',
    diagnosticCategory: 'completion'
  })
})

it('无写入时报告阻塞返回结果并保留阻塞原因', async () => {
  const { output } = await runScene(
    [
      {
        name: 'json',
        args: {
          action: 'report_blocked',
          blockedReason: '缺少告别后去向的要求',
          summary: '需要补充要求',
          writtenFiles: [],
          usedAssetIds: [],
          unresolvedIssues: [],
          tradeoffs: [],
          questions: []
        }
      }
    ],
    undefined,
    { contextWindow: 32000, contextInputBudgetTokens: 20000 }
  )
  expect(output.action).toBe('report_blocked')
  expect(output.blockedReason).toBe('缺少告别后去向的要求')
  expect(output.writtenFiles).toEqual([])
})

it('非法结构化结果收到一次修正提示后仍可完成', async () => {
  const script = 'game/scene/start.txt'
  const budget = new ExecutionBudget({ modelAttempts: 8, toolCalls: 8, activeMs: 900000 })
  const { output, bodies } = await runScene(
    [
      { name: 'writeText', args: { path: script, content: 'alpha' } },
      { name: 'structured', args: { wrong: true } },
      {
        name: 'structured',
        args: {
          action: 'submit_scene_result',
          summary: '修正后完成',
          writtenFiles: [script],
          usedAssetIds: [],
          unresolvedIssues: [],
          tradeoffs: [],
          questions: []
        }
      }
    ],
    budget,
    { channel: 'tool' }
  )
  expect(output.writtenFiles).toEqual([script])
  expect(budget.errorAttempts).toBe(0)
  expect(JSON.stringify(bodies.at(-1))).toContain('完成结果不符合约定')
})

it('持续非法的结构化结果由写后完成契约有界终止', async () => {
  const budget = new ExecutionBudget({ modelAttempts: 8, toolCalls: 8, activeMs: 900000 })
  await expect(
    runScene(
      [
        {
          name: 'writeText',
          args: { path: 'game/scene/start.txt', content: 'alpha' }
        },
        { name: 'structured', args: { wrong: true } }
      ],
      budget,
      { channel: 'tool' }
    )
  ).rejects.toThrow('需要收尾提交结构化结果')
  expect(budget.errorAttempts).toBe(0)
  expect(budget.usage.modelAttempts).toBeGreaterThan(0)
  expect(budget.usage.modelAttempts).toBeLessThan(30)
})

it('文件变化后的再次读取不算无进展', async () => {
  const script = 'game/scene/start.txt'
  const { bodies } = await runScene([
    { name: 'readTextRange', args: { path: script, start: 0, maxChars: 20 } },
    { name: 'writeText', args: { path: script, content: 'beta' } },
    { name: 'readTextRange', args: { path: script, start: 0, maxChars: 20 } },
    {
      name: 'structured',
      args: {
        action: 'submit_scene_result',
        summary: '写入后回读',
        writtenFiles: [script],
        usedAssetIds: [],
        unresolvedIssues: [],
        tradeoffs: [],
        questions: []
      }
    }
  ])
  expect(bodies.every((body) => !JSON.stringify(body).includes('未产生进展'))).toBe(true)
})

it('写入记录被上下文裁剪后，仍承认本次实际写入', async () => {
  const script = 'game/scene/start.txt'
  const marker = 'EARLY_WRITE_MARKER'
  const filler = 'x'.repeat(20000)
  const { output, bodies } = await runScene(
    [
      { name: 'writeText', args: { path: script, content: marker } },
      { name: 'writeText', args: { path: script, content: filler } },
      { name: 'readTextRange', args: { path: script, start: 0, maxChars: 20000 } },
      {
        name: 'structured',
        args: {
          action: 'submit_scene_result',
          summary: '裁剪后仍承认写入',
          writtenFiles: [script],
          usedAssetIds: [],
          unresolvedIssues: [],
          tradeoffs: [],
          questions: []
        }
      }
    ],
    new ExecutionBudget({ modelAttempts: 16, toolCalls: 16, activeMs: 900000 }),
    { toolResultCharLimit: 30000 }
  )
  const sceneBodies = bodies.filter(
    (body) => !JSON.stringify(body).includes('Context Extraction Assistant')
  )
  expect(JSON.stringify(sceneBodies[1])).toContain(marker)
  expect(JSON.stringify(sceneBodies.at(-1))).not.toContain(marker)
  expect(output.writtenFiles).toEqual([script])
})

it('收尾阶段原生通道调用文件工具被拦截且不执行', async () => {
  const script = 'game/scene/start.txt'
  const { output, bodies, workspace } = await runScene(
    [
      { name: 'writeText', args: { path: script, content: 'blocked-write' } },
      {
        name: 'json',
        args: {
          action: 'submit_scene_result',
          summary: '收尾提交',
          writtenFiles: [script],
          usedAssetIds: [],
          unresolvedIssues: [],
          tradeoffs: [],
          questions: []
        }
      }
    ],
    new ExecutionBudget({ modelAttempts: 8, toolCalls: 8, activeMs: 900000 }),
    { mode: 'finalize', writtenFiles: [script] }
  )
  expect(await readFile(join(workspace, script), 'utf8')).toBe('origin')
  expect(JSON.stringify(bodies.at(-1))).toContain('收尾阶段不能调用工具')
  expect(output.summary).toBe('收尾提交')
})

it('收尾阶段工具通道仍放行提交工具', async () => {
  const script = 'game/scene/start.txt'
  const { output, choices } = await runScene(
    [
      {
        name: 'structured',
        args: {
          action: 'submit_scene_result',
          summary: '收尾提交',
          writtenFiles: [script],
          usedAssetIds: [],
          unresolvedIssues: [],
          tradeoffs: [],
          questions: []
        }
      }
    ],
    new ExecutionBudget({ modelAttempts: 8, toolCalls: 8, activeMs: 900000 }),
    { channel: 'tool', mode: 'finalize', writtenFiles: [script] }
  )
  expect(choices).toContain('submit_scene_result')
  expect(output.summary).toBe('收尾提交')
})

type PlannedCall = { name: string; args: Record<string, unknown> }

async function runScene(
  plan: readonly PlannedCall[],
  budget = new ExecutionBudget({ modelAttempts: 16, toolCalls: 16, activeMs: 900000 }),
  options: {
    toolResultCharLimit?: number
    contextWindow?: number
    contextInputBudgetTokens?: number
    channel?: 'native' | 'tool'
    mode?: 'generate' | 'finalize'
    writtenFiles?: readonly string[]
  } = {}
): Promise<{
  output: {
    writtenFiles: readonly string[]
    action: string
    summary: string
    blockedReason?: string
    questions: ReadonlyArray<{ prompt: string }>
  }
  choices: string[]
  workspace: string
  bodies: unknown[]
}> {
  const workspace = await mkdtemp(join(tmpdir(), 'scene-protocol-'))
  roots.push(workspace)
  await mkdir(join(workspace, 'game/scene'), { recursive: true })
  await writeFile(join(workspace, 'game/scene/start.txt'), 'origin')
  const choices: string[] = []
  const bodies: unknown[] = []
  const model = `chosen-${crypto.randomUUID()}`
  let step = 0
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    bodies.push(body)
    if (JSON.stringify(body).includes('Context Extraction Assistant')) {
      return Response.json(textMessage('摘要'))
    }
    const tools = (body.tools as Array<{ function?: { name?: string } }> | undefined)?.flatMap(
      (item) => (item.function?.name ? [item.function.name] : [])
    )
    const toolMode = tools?.includes('submit_scene_result') === true
    const format = (body.response_format as { type?: string } | undefined)?.type
    if (options.channel === 'tool' && (format === 'json_schema' || format === 'json_object')) {
      return Response.json(
        { error: { message: `${format} is not supported`, type: 'invalid_request_error' } },
        { status: 400 }
      )
    }
    const planned = plan[Math.min(step, plan.length - 1)]!
    step += 1
    const structured = tools?.find(
      (name) => !['writeText', 'replaceText', 'readTextRange', 'listDirectory'].includes(name)
    )
    const name =
      planned.name === 'json' || planned.name === 'structured'
        ? toolMode
          ? (structured ?? 'submit_scene_result')
          : planned.name
        : planned.name
    const forced = forcedToolName(body)
    choices.push(forced ?? '')
    if (forced && forced !== name) throw new Error('模型替身忽略了 tool_choice')
    if (planned.name === 'json' || planned.name === 'structured') {
      return Response.json(
        toolMode ? toolMessage(name, planned.args, step) : textMessage(JSON.stringify(planned.args))
      )
    }
    return Response.json(toolMessage(name, planned.args, step))
  })
  vi.stubEnv('OPENAI_API_KEY', 'ambient-openai-key')
  const factory = new LangChainAgentFactoryImpl(
    new LangChainModelFactory(
      async () => ({
        providerId: 'openai-compatible',
        baseUrl: 'https://service.example/v1',
        model,
        contextWindow: options.contextWindow ?? 8000,
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
      contextInputBudgetTokens: options.contextInputBudgetTokens ?? 6800,
      ...(options.toolResultCharLimit !== undefined
        ? { toolResultCharLimit: options.toolResultCharLimit }
        : {})
    }
  })
  try {
    const output = await agent.invoke(
      sceneInput(options.mode ?? 'generate', options.writtenFiles),
      execution(workspace, budget)
    )
    return { output, choices, workspace, bodies }
  } finally {
    vi.unstubAllEnvs()
  }
}

function sceneInput(
  mode: 'generate' | 'finalize' = 'generate',
  writtenFiles?: readonly string[]
): Parameters<WebGalSceneAgentImpl['invoke']>[0] {
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
    step: 'generating' as const,
    attempt: 0,
    sequence: 0,
    budget: { correctionsUsed: 0, modelCallsUsed: 0, toolCallsUsed: 0, activeElapsedMs: 0 },
    replies: []
  } satisfies SceneGenerationExecution
  return {
    mode,
    execution: executionFact,
    ...(writtenFiles !== undefined ? { writtenFiles } : {})
  }
}

function execution(workspace: string, budget: ExecutionBudget): AgentExecution {
  return {
    identity: { executionId: 'protocol-run' },
    scope: { threadId: 'protocol-thread' },
    context: {
      budget,
      requiredMessageIds: ['webgal-current-facts'],
      workspace: {
        root: workspace,
        writable: true,
        writablePaths: ['game/scene/start.txt']
      }
    }
  }
}

function forcedToolName(body: Record<string, unknown>): string | undefined {
  const choice = body.tool_choice
  if (!choice || typeof choice !== 'object' || !('function' in choice)) return undefined
  const definition = choice.function
  if (!definition || typeof definition !== 'object' || !('name' in definition)) return undefined
  return typeof definition.name === 'string' ? definition.name : undefined
}

function clarificationQuestion(prompt: string): {
  prompt: string
  options: Array<{ label: string; description: string }>
} {
  return {
    prompt,
    options: [
      { label: '甲', description: '第一项' },
      { label: '乙', description: '第二项' },
      { label: '丙', description: '第三项' }
    ]
  }
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
