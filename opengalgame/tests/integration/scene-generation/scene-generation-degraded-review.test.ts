import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Command, isInterrupted } from '@langchain/langgraph'
import type { ReactAgent } from 'langchain'

import type {
  SceneGenerationCandidate,
  SceneGenerationExecution
} from '@application/scene-generation/models/SceneGenerationExecution'
import type { SceneGenerationArtifact } from '@domain/scene-generation/models/SceneGenerationArtifact'
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
import { FileCheckpointSaver } from '@infrastructure/workflow/checkpoints/FileCheckpointSaver'
import { langGraphThreadKey } from '@infrastructure/workflow/WorkflowIdentity'

const ENTRY = 'game/scene/start.txt'
const EXTRA = 'game/scene/other.txt'
const LEGACY_SUMMARY_NOTICE = '完成摘要未生成，请核对创作取舍'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

type ReplyKind = 'revise' | 'accept'

it('写后契约失败降级后，新的写入清除降级事实并回到正常审阅', async () => {
  const harness = await degradedHarness()

  const first = await harness.graph.invoke(harness.input(), harness.config)
  expect(isInterrupted(first)).toBe(true)
  const degraded = await harness.graph.getState(harness.config)
  expect(degraded.values.status).toBe('waiting')
  expect(degraded.values.summaryDegraded).toBe(true)
  const degradedInteraction = generationInteraction(degraded.values, 'checkpoint-degraded')
  expect(degradedInteraction.kind).toBe('review')
  expect(degradedInteraction.message).toContain(LEGACY_SUMMARY_NOTICE)
  expect(degradedInteraction.allowedReplies).toEqual(
    expect.arrayContaining(['accept', 'revise', 'discard'])
  )

  reply(harness, { kind: 'revise', body: '按说明重新写一次' }, 'reply-degraded-1')
  const resumed = await harness.graph.invoke(
    new Command({ resume: 'reply-degraded-1' }),
    harness.config
  )
  expect(isInterrupted(resumed)).toBe(true)
  expect(harness.calls).toBe(2)

  const reviewed = await harness.graph.getState(harness.config)
  expect(reviewed.values.status).toBe('waiting')
  expect(reviewed.values.summaryDegraded).toBe(false)
  expect(reviewed.values.outcome).toMatchObject({ kind: 'candidate' })
  const interaction = generationInteraction(reviewed.values, 'checkpoint-review')
  expect(interaction.kind).toBe('review')
  expect(interaction.message).not.toContain(LEGACY_SUMMARY_NOTICE)
})

it('降级解除后的审阅可以接受并直接完成，accept 不再是空操作', async () => {
  const harness = await degradedHarness()
  await harness.graph.invoke(harness.input(), harness.config)

  reply(harness, { kind: 'revise', body: '按说明重新写一次' }, 'reply-degraded-1')
  await harness.graph.invoke(new Command({ resume: 'reply-degraded-1' }), harness.config)

  reply(harness, { kind: 'accept' }, 'reply-accept')
  const accepted = await harness.graph.invoke(new Command({ resume: 'reply-accept' }), harness.config)

  expect(isInterrupted(accepted)).toBe(false)
  const done = await harness.graph.getState(harness.config)
  expect(done.values.status).toBe('ready')
  expect(done.values.summaryDegraded).toBe(false)
  expect(harness.calls).toBe(2)
})

interface DegradedHarness {
  graph: WebGalGenerationGraph
  config: { configurable: { thread_id: string; checkpoint_ns: string }; recursionLimit: number }
  input: () => Record<string, unknown>
  live: { execution: SceneGenerationExecution }
  readonly calls: number
}

/**
 * 第一次生成声明了未实际写入的文件，属写后契约失败并降级；
 * 之后的修正写入带出完整结构化结果，不再降级。
 */
async function degradedHarness(): Promise<DegradedHarness> {
  const root = await mkdtemp(join(tmpdir(), 'scene-degraded-review-'))
  roots.push(root)
  const execution = baseExecution(root)
  const live = { execution }
  const calls = { count: 0 }
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
    agent: new WebGalSceneAgentImpl(degradedExecutor(calls)),
    artifacts: {
      readCandidate: (_execution, candidateSnapshotId) =>
        Promise.resolve({ ...candidate, candidateSnapshotId }),
      saveCandidateRevision: () =>
        Promise.resolve({
          candidateSnapshotId: createHash('sha256').update(`${root}:${calls.count}`).digest('hex')
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
    live,
    get calls() {
      return calls.count
    },
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

function degradedExecutor(calls: { count: number }): ReactAgent {
  return {
    invoke: (
      _input: unknown,
      config: { context: { budget: ExecutionBudget } }
    ): Promise<{ structuredResponse: WebGalSceneAgentOutput; messages: [] }> => {
      calls.count += 1
      recordWrittenFile(config.context.budget, {
        path: ENTRY,
        version: `write-${calls.count}`
      })
      if (calls.count === 1) {
        // 声明了未写出的候选脚本：智能体在抛出点标记 structured-output，写后契约失败并降级。
        return Promise.resolve({
          structuredResponse: result({
            action: 'submit_scene_result',
            writtenFiles: [ENTRY, EXTRA]
          }),
          messages: []
        })
      }
      return Promise.resolve({
        structuredResponse: result({ action: 'submit_scene_result', writtenFiles: [ENTRY] }),
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

/** 图级测试模拟一次用户回复：先写入 pendingReply，再用同一个 replyId 恢复中断。 */
function reply(
  harness: DegradedHarness,
  body: { kind: ReplyKind; body?: string },
  replyId: string
): void {
  const pending = {
    projectId: 'project1',
    sceneId: 'scene1',
    operationId: 'operation1',
    interactionId: 'interaction-1',
    replyId,
    reply:
      body.kind === 'revise'
        ? { kind: 'revise' as const, body: body.body ?? '' }
        : { kind: 'accept' as const }
  }
  harness.live.execution = {
    ...harness.live.execution,
    pendingReply: pending,
    replies: [...(harness.live.execution.replies ?? []), pending]
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
