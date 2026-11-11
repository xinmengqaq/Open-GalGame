import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

import {
  createSceneGenerationFixture,
  generationRequest
} from '../../unit/application/scene-generation/sceneGenerationFixture'
import type {
  SceneGenerationExecution,
  SceneGenerationRuntime,
  SceneGenerationWorkflowProgress
} from '@application/scene-generation/models/SceneGenerationExecution'
import { ExecutionBudget } from '@infrastructure/ai/execution/ExecutionBudget'
import { webGalGenerationCompatibility } from '@infrastructure/scene-generation/history/WebGalGenerationCheckpoint'
import { createWebGalGenerationGraph } from '@infrastructure/scene-generation/workflow/createWebGalGenerationGraph'
import { terminalPhase } from '@infrastructure/scene-generation/workflow/WebGalSceneGenerationWorkflowImpl'
import { FileCheckpointSaver } from '@infrastructure/workflow/checkpoints/FileCheckpointSaver'
import { langGraphThreadKey } from '@infrastructure/workflow/WorkflowIdentity'

const roots: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('活跃超时记为失败，用户取消记为取消', async () => {
  const root = await mkdtemp(join(tmpdir(), 'terminal-phase-'))
  roots.push(root)
  const execution = executionOf(root)
  const activeTimeout = new AbortController()
  activeTimeout.abort()
  const user = new AbortController()
  user.abort()
  const runtime = (
    overrides: Partial<
      Pick<SceneGenerationRuntime, 'signal' | 'userAbortSignal' | 'activeTimeoutSignal'>
    >
  ): SceneGenerationRuntime => ({
    execution,
    signal: new AbortController().signal,
    userAbortSignal: new AbortController().signal,
    activeTimeoutSignal: new AbortController().signal,
    publishProgress: async () => execution,
    recordCandidateRevision: async (revision) => ({
      ...execution,
      candidateSnapshotId: revision.candidateSnapshotId
    }),
    recordFailure: async (failure) => ({
      ...execution,
      failure
    }),
    ...overrides
  })
  // 生产协调器当前把 activeTimeoutSignal 设为永不中止、预算上限为 MAX_SAFE_INTEGER，
  // 端到端无法构造活跃超时；这里直接锁定终态阶段区分。
  expect(
    terminalPhase(
      runtime({ signal: activeTimeout.signal, activeTimeoutSignal: activeTimeout.signal })
    )
  ).toBe('failed')
  expect(terminalPhase(runtime({ signal: user.signal, userAbortSignal: user.signal }))).toBe(
    'cancelled'
  )
  expect(
    terminalPhase(
      runtime({
        signal: user.signal,
        userAbortSignal: user.signal,
        activeTimeoutSignal: activeTimeout.signal
      })
    )
  ).toBe('cancelled')
})

it('终态写入后迟到的进度发布不改变 step、live 和 budget', async () => {
  const fixture = createSceneGenerationFixture()
  let publishProgress: ((progress: SceneGenerationWorkflowProgress) => Promise<unknown>) | undefined
  fixture.workflow.executeGeneration.mockImplementationOnce(async (runtime) => {
    publishProgress = runtime.publishProgress
    return new Promise(() => undefined)
  })
  await fixture.service.generateScene(generationRequest)
  const running = fixture.runNext()
  await vi.waitFor(() => {
    expect(publishProgress).toBeTypeOf('function')
  })
  const active = fixture.coordinator.activeExecutions.get(
    JSON.stringify(['project-1', 'scene-1', 'operation-1'])
  )
  if (!active || !publishProgress) throw new Error('执行槽和进度回调应当已建立')
  active.controller.abort()
  const recovering = fixture.coordinator.recoverFailure(
    active,
    new Error('场景生成已取消'),
    true,
    false
  )
  await vi.waitFor(() => {
    expect(fixture.executions.get('operation-1')?.state).toBe('cancelled')
  })
  const settled = fixture.executions.get('operation-1')
  const publishing = publishProgress({
    step: 'generating',
    attempt: 1,
    budget: { correctionsUsed: 0, modelCallsUsed: 9, toolCallsUsed: 4, activeElapsedMs: 20 },
    live: { activity: 'waitingModel', lastActivityAt: '2026-10-29T00:00:00.000Z' }
  })
  await recovering
  await publishing
  const recorded = fixture.executions.get('operation-1')
  expect(recorded?.state).toBe('cancelled')
  expect(recorded?.step).toBeUndefined()
  expect(recorded?.live).toBeUndefined()
  expect(recorded?.budget.modelCallsUsed).toBe(settled?.budget.modelCallsUsed)
  expect(recorded?.budget.toolCallsUsed).toBe(settled?.budget.toolCallsUsed)
  expect(recorded?.budget.activeElapsedMs).toBe(settled?.budget.activeElapsedMs)
  void running
})

it('生成中发布 generating，结束后定时器停止', async () => {
  vi.useFakeTimers()
  const root = await mkdtemp(join(tmpdir(), 'live-progress-'))
  roots.push(root)
  const published: SceneGenerationWorkflowProgress[] = []
  const gate = Promise.withResolvers<void>()
  const budget = new ExecutionBudget({ modelAttempts: 4, toolCalls: 4, activeMs: 900000 })
  budget.consumeModelAttempt()
  const execution = executionOf(root)
  const graph = createWebGalGenerationGraph({
    stateRoot: root,
    saver: new FileCheckpointSaver(root),
    budget,
    runtime: {
      execution,
      signal: new AbortController().signal,
      userAbortSignal: new AbortController().signal,
      activeTimeoutSignal: new AbortController().signal,
      publishProgress: (progress) => {
        published.push(progress)
        return Promise.resolve({ ...execution, step: progress.step, budget: progress.budget })
      },
      recordCandidateRevision: (revision) =>
        Promise.resolve({ ...execution, candidateSnapshotId: revision.candidateSnapshotId })
    },
    agent: {
      invoke: () => {
        gate.resolve()
        const done = Promise.withResolvers<AgentReply>()
        setTimeout(() => done.resolve(writtenReply()), 1600)
        return done.promise
      }
    },
    artifacts: {
      readCandidate: () => Promise.reject(new Error('本用例在校验前停止')),
      saveCandidateRevision: () =>
        Promise.resolve({
          candidateSnapshotId: createHash('sha256').update('saved').digest('hex')
        }),
      writeCandidateFiles: () => Promise.resolve({ candidateSnapshotId: 'unused' })
    }
  })
  const running = graph.invoke(inputOf(execution), {
    configurable: { thread_id: langGraphThreadKey(execution), checkpoint_ns: '' }
  })
  await gate.promise
  expect(
    published.some((item) => item.step === 'generating' && item.budget.modelCallsUsed > 0)
  ).toBe(true)
  const during = published.length
  await vi.advanceTimersByTimeAsync(1500)
  expect(published.length).toBeGreaterThan(during)
  await vi.advanceTimersByTimeAsync(100)
  await running.catch(() => undefined)
  const finished = published.length
  await vi.advanceTimersByTimeAsync(5000)
  expect(published.length).toBe(finished)
})

interface AgentReply {
  summary: string
  writtenFiles: string[]
  usedAssetIds: string[]
  unresolvedIssues: string[]
  tradeoffs: string[]
  memoryMessages: string[]
}

function writtenReply(): AgentReply {
  return {
    summary: '已写出',
    writtenFiles: ['game/scene/start.txt'],
    usedAssetIds: [],
    unresolvedIssues: [],
    tradeoffs: [],
    memoryMessages: []
  }
}

function executionOf(root: string): SceneGenerationExecution {
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
      prompts: [],
      fieldBindings: [],
      relations: [],
      confirmedControls: []
    },
    policy: { maxCorrections: 1 },
    reviewCandidate: false,
    baseline: { commitId: 'base', affectedFiles: [], lockState: 'unlocked' },
    state: 'running',
    step: 'preparing',
    attempt: 1,
    sequence: 0,
    budget: { correctionsUsed: 0, modelCallsUsed: 0, toolCallsUsed: 0, activeElapsedMs: 0 },
    replies: [],
    workspace: { workspaceId: 'workspace-1', rootDirectory: root, sceneDirectory: 'game/scene' }
  }
}

function inputOf(execution: SceneGenerationExecution) {
  return {
    execution,
    mode: 'generate' as const,
    candidate: undefined,
    summary: '',
    unresolvedIssues: [],
    memoryMessages: [],
    confirmedReplies: [],
    status: 'working' as const,
    needsDecision: false,
    correctableIssueKey: '',
    compatibility: webGalGenerationCompatibility()
  }
}
