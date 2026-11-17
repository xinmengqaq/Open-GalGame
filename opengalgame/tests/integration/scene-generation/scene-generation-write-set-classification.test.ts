import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { isInterrupted } from '@langchain/langgraph'
import type { ReactAgent } from 'langchain'

import type { ReplySceneGenerationInteractionDTO } from '@application/scene-generation/dto/SceneGenerationDTO'
import type { SceneGenerationArtifact } from '@domain/scene-generation/models/SceneGenerationArtifact'
import { SceneGenerationDomainServiceImpl } from '@domain/scene-generation/services/impl/SceneGenerationDomainServiceImpl'
import type {
  SceneGenerationCandidate,
  SceneGenerationExecution,
  SceneGenerationWorkflowProgress
} from '@application/scene-generation/models/SceneGenerationExecution'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { AgentExecution } from '@infrastructure/ai/agents/AgentExecution'
import { ExecutionBudget } from '@infrastructure/ai/execution/ExecutionBudget'
import { recordWrittenFile } from '@infrastructure/ai/execution/writtenFileLedger'
import { WebGalSceneAgentImpl } from '@infrastructure/scene-generation/agents/WebGalSceneAgentImpl'
import type { WebGalSceneAgentOutput } from '@infrastructure/scene-generation/agents/WebGalSceneAgentTypes'
import { webGalGenerationCompatibility } from '@infrastructure/scene-generation/history/WebGalGenerationCheckpoint'
import {
  createWebGalGenerationGraph,
  generationInteraction,
  type WebGalGenerationGraph
} from '@infrastructure/scene-generation/workflow/createWebGalGenerationGraph'
import {
  classifyRunError,
  failureCodeOf
} from '@infrastructure/scene-generation/workflow/runFailureRouting'
import type { DurableEffectRecord } from '@infrastructure/workflow/DurableEffectRecord'
import {
  readDurableEffects,
  writeDurableEffect
} from '@infrastructure/workflow/execution/durableEffect'
import { FileCheckpointSaver } from '@infrastructure/workflow/checkpoints/FileCheckpointSaver'
import { langGraphThreadKey } from '@infrastructure/workflow/WorkflowIdentity'

const ENTRY = 'game/scene/start.txt'
const EXTRA = 'game/scene/other.txt'
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('写入集合不一致在智能体抛出点标记 structured-output，并归入 outputContract', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scene-write-set-agent-'))
  roots.push(root)
  const budget = new ExecutionBudget({ modelAttempts: 8, toolCalls: 8, activeMs: 60000 })
  const agent = new WebGalSceneAgentImpl(executor('declared-after-write'))
  const context: AgentExecution = {
    identity: { executionId: 'write-set-run' },
    scope: { threadId: 'write-set-thread' },
    context: {
      budget,
      workspace: { root, writable: true, writablePaths: [ENTRY] }
    }
  }

  const error = await agent
    .invoke({ mode: 'generate', execution: baseExecution(root) }, context)
    .catch((reason: unknown) => reason)

  expect(error).toBeInstanceOf(AppException)
  expect(error).toMatchObject({
    code: ErrorCodes.operationConflict,
    diagnosticCategory: 'structured-output',
    message: '智能体完成结果与实际候选脚本写入不一致'
  })
  expect(classifyRunError(error, undefined)).toMatchObject({
    failureClass: 'outputContract',
    reason: 'structuredOutput',
    retryable: false
  })
})

it('已写入的写入集合不一致保留候选并进入审阅', async () => {
  const harness = await runHarness(executor('declared-after-write'))

  const interrupted = await harness.graph.invoke(harness.input(), harness.config)

  expect(isInterrupted(interrupted)).toBe(true)
  const waiting = await harness.graph.getState(harness.config)
  expect(waiting.values.status).toBe('waiting')
  expect(waiting.values.summaryDegraded).toBe(true)
  expect(waiting.values.execution.candidateSnapshotId).toMatch(/^[0-9a-f]{64}$/u)
  expect(waiting.values.outcome).toMatchObject({
    kind: 'contractError',
    failureClass: 'outputContract',
    reason: 'structuredOutput',
    degraded: true
  })
  expect(generationInteraction(waiting.values, 'checkpoint-1').kind).toBe('review')
})

it('未写入的写入集合不一致抛出结构化错误，分类仍为 outputContract', async () => {
  const harness = await runHarness(executor('declared-without-write'))

  const error = await harness.graph
    .invoke(harness.input(), harness.config)
    .catch((reason) => reason)

  expect(error).toBeInstanceOf(AppException)
  expect(error).toMatchObject({
    code: ErrorCodes.operationConflict,
    diagnosticCategory: 'structured-output',
    message: '智能体完成结果与实际候选脚本写入不一致'
  })
  const classified = classifyRunError(error, undefined)
  expect(classified).toMatchObject({
    failureClass: 'outputContract',
    reason: 'structuredOutput',
    retryable: false
  })
  expect(failureCodeOf(classified!.failureClass)).toBe(ErrorCodes.operationConflict)
  expect(failureCodeOf(classified!.failureClass)).not.toBe(ErrorCodes.internalError)
  const state = await harness.graph.getState(harness.config)
  expect(state.values.status).toBe('working')
  expect(state.values.failureClass).toBeUndefined()
})

it('已完成写入按输入摘要回放：同摘要跳过模型，输入变化按冲突停止', async () => {
  let calls = 0
  const harness = await runHarness(
    executor('valid-write', () => {
      calls += 1
    }),
    { reviewCandidate: false }
  )
  await harness.graph.invoke(harness.input(), harness.config)
  const first = await harness.graph.getState(harness.config)
  const revision = first.values.execution.candidateSnapshotId
  expect(revision).toMatch(/^[0-9a-f]{64}$/u)
  expect(calls).toBe(1)
  const [effect] = await readDurableEffects(harness.root, harness.execution)
  expect(effect).toMatchObject({
    stepId: 'generate-0-initial',
    status: 'completed',
    candidateRevision: revision,
    resultDigest: revision
  })
  expect(effect?.inputDigest).toMatch(/^[0-9a-f]{64}$/u)

  const replayConfig = harness.configFor('replay')
  const replayed = await harness.graph.invoke(harness.stateInput(harness.execution), replayConfig)
  expect(calls).toBe(1)
  expect(replayed.outcome).toMatchObject({
    kind: 'candidate',
    candidateSnapshotId: revision
  })
  expect(replayed.execution.candidateSnapshotId).toBe(revision)
  expect(await readDurableEffects(harness.root, harness.execution)).toEqual([effect])

  const changed = {
    ...harness.execution,
    inputSnapshot: {
      ...harness.execution.inputSnapshot,
      prompts: harness.execution.inputSnapshot.prompts.map((prompt) => ({
        ...prompt,
        body: `${prompt.body}换一种写法。`
      }))
    }
  }
  const conflictConfig = harness.configFor('changed')
  const error = await harness.graph
    .invoke(harness.stateInput(changed), conflictConfig)
    .catch((reason: unknown) => reason)
  expect(error).toBeInstanceOf(AppException)
  expect(error).toMatchObject({
    code: ErrorCodes.operationConflict,
    message: expect.stringContaining('输入不兼容')
  })
  expect(calls).toBe(1)
  expect(await readDurableEffects(harness.root, harness.execution)).toEqual([effect])
})

it('未完成的副作用停止恢复，不调用智能体也不覆盖记录', async () => {
  let calls = 0
  const harness = await runHarness(
    executor('valid-write', () => {
      calls += 1
    }),
    { reviewCandidate: false }
  )
  const started: DurableEffectRecord = {
    operationId: harness.execution.operationId,
    stepId: 'generate-0-initial',
    inputDigest: 'input-pending',
    status: 'started',
    kind: 'fileWrite'
  }
  await writeDurableEffect(harness.root, harness.execution, started)

  const error = await harness.graph
    .invoke(harness.input(), harness.config)
    .catch((reason: unknown) => reason)
  expect(error).toBeInstanceOf(AppException)
  expect(error).toMatchObject({
    code: ErrorCodes.operationConflict,
    message: expect.stringContaining('结果不明')
  })
  expect(calls).toBe(0)
  expect(await readDurableEffects(harness.root, harness.execution)).toEqual([started])
})

it('stepId 由模式、修正次数、回复标识与重试后缀组成', async () => {
  const pendingReply: ReplySceneGenerationInteractionDTO = {
    projectId: 'project1',
    sceneId: 'scene1',
    branchId: 'branch1',
    operationId: 'operation1',
    interactionId: 'interaction-1',
    checkpointId: 'checkpoint-1',
    replyId: 'reply-9',
    reply: { kind: 'revise', body: '保留道别' }
  }
  const harness = await runHarness(executor('valid-write'), {
    mode: 'repair',
    reviewCandidate: false,
    correctionsUsed: 1,
    pendingReply,
    replies: [pendingReply],
    retryCount: 2
  })

  await harness.graph.invoke(harness.input(), harness.config)

  const effects = await readDurableEffects(harness.root, harness.execution)
  expect(effects.map((effect) => effect.stepId)).toEqual(['repair-1-reply-9-r2'])
  expect(effects[0]?.inputDigest).toMatch(/^[0-9a-f]{64}$/u)
})

it('生成心跳每 1500ms 单飞，结束后在 finally 清理', async () => {
  vi.useFakeTimers()
  try {
    let generating = 0
    let releaseFirst: (() => void) | undefined
    const agentStarted = Promise.withResolvers<void>()
    const harness = await runHarness(
      {
        invoke: (
          _input: unknown,
          config: { context: { budget: ExecutionBudget } }
        ): Promise<{ structuredResponse: WebGalSceneAgentOutput; messages: [] }> => {
          agentStarted.resolve()
          const { promise, resolve } = Promise.withResolvers<{
            structuredResponse: WebGalSceneAgentOutput
            messages: []
          }>()
          setTimeout(() => {
            recordWrittenFile(config.context.budget, { path: ENTRY, version: 'heartbeat' })
            resolve({
              structuredResponse: result({ action: 'submit_scene_result', writtenFiles: [ENTRY] }),
              messages: []
            })
          }, 5000)
          return promise
        }
      } as unknown as ReactAgent,
      {
        reviewCandidate: false,
        publishProgress: (progress, live) => {
          if (progress.step === 'generating') {
            generating += 1
            if (generating === 1) {
              const gate = Promise.withResolvers<SceneGenerationExecution>()
              releaseFirst = () => {
                live.execution = {
                  ...live.execution,
                  step: progress.step,
                  budget: progress.budget
                }
                gate.resolve(live.execution)
              }
              return gate.promise
            }
          }
          live.execution = {
            ...live.execution,
            step: progress.step,
            budget: progress.budget,
            ...(progress.candidateSnapshotId
              ? { candidateSnapshotId: progress.candidateSnapshotId }
              : {})
          }
          return Promise.resolve(live.execution)
        }
      }
    )

    const running = harness.graph.invoke(harness.input(), harness.config)
    await agentStarted.promise
    expect(generating).toBe(1)
    await vi.advanceTimersByTimeAsync(1500)
    await vi.advanceTimersByTimeAsync(1500)
    expect(generating).toBe(1)

    if (!releaseFirst) throw new Error('首次进度发布未挂起')
    releaseFirst()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1400)
    expect(generating).toBe(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(generating).toBe(2)

    await vi.advanceTimersByTimeAsync(2000)
    await running
    expect(generating).toBe(2)
    await vi.advanceTimersByTimeAsync(5000)
    expect(generating).toBe(2)
  } finally {
    vi.useRealTimers()
  }
})

type ExecutorBehavior = 'declared-after-write' | 'declared-without-write' | 'valid-write'

function executor(behavior: ExecutorBehavior, onInvoke?: () => void): ReactAgent {
  return {
    invoke: (
      _input: unknown,
      config: { context: { budget: ExecutionBudget } }
    ): Promise<{ structuredResponse: WebGalSceneAgentOutput; messages: [] }> => {
      onInvoke?.()
      if (behavior === 'valid-write') {
        recordWrittenFile(config.context.budget, { path: ENTRY, version: 'write-valid' })
        return Promise.resolve({
          structuredResponse: result({ action: 'submit_scene_result', writtenFiles: [ENTRY] }),
          messages: []
        })
      }
      if (behavior === 'declared-after-write') {
        recordWrittenFile(config.context.budget, { path: ENTRY, version: 'write-1' })
        return Promise.resolve({
          structuredResponse: result({
            action: 'submit_scene_result',
            writtenFiles: [ENTRY, EXTRA]
          }),
          messages: []
        })
      }
      return Promise.resolve({
        structuredResponse: result({
          action: 'report_blocked',
          blockedReason: '缺少可用的版权素材',
          writtenFiles: [ENTRY]
        }),
        messages: []
      })
    }
  } as unknown as ReactAgent
}

function result(overrides: Partial<WebGalSceneAgentOutput>): WebGalSceneAgentOutput {
  return {
    action: 'submit_scene_result',
    summary: '车站道别',
    writtenFiles: [],
    usedAssetIds: [],
    unresolvedIssues: [],
    tradeoffs: [],
    questions: [],
    memoryMessages: [],
    ...overrides
  }
}

type HarnessOptions = {
  mode?: 'generate' | 'repair' | 'validate'
  reviewCandidate?: boolean
  correctionsUsed?: number
  pendingReply?: ReplySceneGenerationInteractionDTO
  replies?: SceneGenerationExecution['replies']
  retryCount?: number
  publishProgress?: (
    progress: SceneGenerationWorkflowProgress,
    live: { execution: SceneGenerationExecution }
  ) => Promise<SceneGenerationExecution>
}

async function runHarness(
  agent: ReactAgent,
  options: HarnessOptions = {}
): Promise<{
  graph: WebGalGenerationGraph
  root: string
  execution: SceneGenerationExecution
  config: { configurable: { thread_id: string; checkpoint_ns: string }; recursionLimit: number }
  configFor: (checkpointNs?: string) => {
    configurable: { thread_id: string; checkpoint_ns: string }
    recursionLimit: number
  }
  input: () => Record<string, unknown>
  stateInput: (execution: SceneGenerationExecution) => Record<string, unknown>
}> {
  const root = await mkdtemp(join(tmpdir(), 'scene-write-set-graph-'))
  roots.push(root)
  const execution = baseExecution(root, options)
  const live = { execution }
  const mode = options.mode ?? 'generate'
  const budget = new ExecutionBudget({ modelAttempts: 32, toolCalls: 32, activeMs: 900000 })
  const candidate = candidateOf(spoken())
  const graph = createWebGalGenerationGraph({
    stateRoot: root,
    saver: new FileCheckpointSaver(root),
    domain: new SceneGenerationDomainServiceImpl(),
    budget,
    runtime: {
      get execution() {
        return live.execution
      },
      signal: new AbortController().signal,
      userAbortSignal: new AbortController().signal,
      activeTimeoutSignal: new AbortController().signal,
      publishProgress: (progress) => {
        if (options.publishProgress) return options.publishProgress(progress, live)
        live.execution = {
          ...live.execution,
          step: progress.step,
          budget: progress.budget,
          ...(progress.candidateSnapshotId
            ? { candidateSnapshotId: progress.candidateSnapshotId }
            : {})
        }
        return Promise.resolve(live.execution)
      },
      recordCandidateRevision: (revision) => {
        live.execution = {
          ...live.execution,
          candidateSnapshotId: revision.candidateSnapshotId
        }
        return Promise.resolve(live.execution)
      },
      recordFailure: (failure) => {
        live.execution = { ...live.execution, failure }
        return Promise.resolve(live.execution)
      }
    },
    agent: new WebGalSceneAgentImpl(agent),
    artifacts: {
      readCandidate: (_execution, candidateSnapshotId) =>
        Promise.resolve({ ...candidate, candidateSnapshotId }),
      saveCandidateRevision: () =>
        Promise.resolve({
          candidateSnapshotId: createHash('sha256').update(root).digest('hex')
        }),
      writeCandidateFiles: () => Promise.resolve({ candidateSnapshotId: 'edited' })
    }
  })
  const configFor = (checkpointNs = ''): {
    configurable: { thread_id: string; checkpoint_ns: string }
    recursionLimit: number
  } => ({
    configurable: { thread_id: langGraphThreadKey(execution), checkpoint_ns: checkpointNs },
    recursionLimit: 80
  })
  const stateInput = (current: SceneGenerationExecution): Record<string, unknown> => ({
    execution: current,
    mode,
    candidate: undefined,
    summary: '',
    unresolvedIssues: [],
    memoryMessages: [],
    confirmedReplies: [],
    status: 'working',
    needsDecision: false,
    correctableIssueKey: '',
    ...(options.retryCount !== undefined ? { retryCount: options.retryCount } : {}),
    compatibility: webGalGenerationCompatibility()
  })
  const config = configFor()
  return {
    graph,
    root,
    execution,
    config,
    configFor,
    input: () => stateInput(live.execution),
    stateInput
  }
}

function baseExecution(
  root: string,
  options: {
    reviewCandidate?: boolean
    correctionsUsed?: number
    pendingReply?: ReplySceneGenerationInteractionDTO
    replies?: SceneGenerationExecution['replies']
  } = {}
): SceneGenerationExecution {
  return {
    projectId: 'project1',
    sceneId: 'scene1',
    operationId: 'operation1',
    threadId: 'thread1',
    branchId: 'branch1',
    fingerprint: 'fingerprint',
    source: {
      projectId: 'project1',
      sceneId: 'scene1',
      projectRoot: root,
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
    reviewCandidate: options.reviewCandidate ?? true,
    baseline: { commitId: 'base', affectedFiles: [], lockState: 'unlocked' },
    state: 'running',
    step: 'generating',
    attempt: 0,
    sequence: 0,
    budget: {
      correctionsUsed: options.correctionsUsed ?? 0,
      modelCallsUsed: 0,
      toolCallsUsed: 0,
      activeElapsedMs: 0
    },
    replies: options.replies ?? [],
    ...(options.pendingReply ? { pendingReply: options.pendingReply } : {}),
    workspace: { workspaceId: 'workspace-1', rootDirectory: root, sceneDirectory: 'game/scene' }
  }
}

function candidateOf(artifact: SceneGenerationArtifact): SceneGenerationCandidate {
  return {
    candidateSnapshotId: 'a'.repeat(64),
    artifact,
    preview: {
      entryFile: ENTRY,
      files: [ENTRY],
      parserVersion: '4.6.5',
      commandLocations: [],
      assetLocations: [],
      validationReport: { issues: [] }
    },
    assetChanges: []
  }
}

function spoken(): SceneGenerationArtifact {
  return {
    scene: { projectId: 'project1', sceneId: 'scene1' },
    hasEntry: true,
    statements: [
      {
        sequence: 0,
        command: 'say',
        commandRecognition: 'recognized',
        argumentRecognition: 'recognized',
        content: '你好',
        assetUses: [],
        dialogueSpeaker: 'explicit',
        waitsForPlayer: true
      }
    ]
  }
}
