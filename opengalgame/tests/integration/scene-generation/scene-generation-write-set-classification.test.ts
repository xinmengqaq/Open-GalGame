import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { isInterrupted } from '@langchain/langgraph'
import type { ReactAgent } from 'langchain'

import type { SceneGenerationArtifact } from '@domain/scene-generation/models/SceneGenerationArtifact'
import type {
  SceneGenerationCandidate,
  SceneGenerationExecution
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

type ExecutorBehavior = 'declared-after-write' | 'declared-without-write'

function executor(behavior: ExecutorBehavior): ReactAgent {
  return {
    invoke: (
      _input: unknown,
      config: { context: { budget: ExecutionBudget } }
    ): Promise<{ structuredResponse: WebGalSceneAgentOutput; messages: [] }> => {
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

async function runHarness(agent: ReactAgent): Promise<{
  graph: WebGalGenerationGraph
  config: { configurable: { thread_id: string; checkpoint_ns: string }; recursionLimit: number }
  input: () => Record<string, unknown>
}> {
  const root = await mkdtemp(join(tmpdir(), 'scene-write-set-graph-'))
  roots.push(root)
  const execution = baseExecution(root)
  const live = { execution }
  const budget = new ExecutionBudget({ modelAttempts: 32, toolCalls: 32, activeMs: 900000 })
  const candidate = candidateOf(spoken())
  const graph = createWebGalGenerationGraph({
    stateRoot: root,
    saver: new FileCheckpointSaver(root),
    budget,
    runtime: {
      get execution() {
        return live.execution
      },
      signal: new AbortController().signal,
      userAbortSignal: new AbortController().signal,
      activeTimeoutSignal: new AbortController().signal,
      publishProgress: (progress) => {
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
  const config = {
    configurable: { thread_id: langGraphThreadKey(execution), checkpoint_ns: '' },
    recursionLimit: 80
  }
  return {
    graph,
    config,
    input: () => ({
      execution: live.execution,
      mode: 'generate',
      candidate: undefined,
      summary: '',
      unresolvedIssues: [],
      memoryMessages: [],
      confirmedReplies: [],
      status: 'working',
      needsDecision: false,
      correctableIssueKey: '',
      compatibility: webGalGenerationCompatibility()
    })
  }
}

function baseExecution(root: string): SceneGenerationExecution {
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
    reviewCandidate: true,
    baseline: { commitId: 'base', affectedFiles: [], lockState: 'unlocked' },
    state: 'running',
    step: 'generating',
    attempt: 0,
    sequence: 0,
    budget: { correctionsUsed: 0, modelCallsUsed: 0, toolCallsUsed: 0, activeElapsedMs: 0 },
    replies: [],
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
