import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

import type {
  SceneGenerationExecution,
  SceneGenerationRuntime,
  SceneGenerationWorkflowProgress
} from '@application/scene-generation/models/SceneGenerationExecution'
import {
  SceneGenerationRunFailed,
  type FailureClass
} from '@application/scene-generation/models/SceneGenerationRunOutcome'
import {
  configureDiagnosticHash,
  publicFailureOf,
  type SceneGenerationFailureFact,
  type SceneGenerationFailureReason,
  type SceneGenerationPublicFailure
} from '@application/scene-generation/services/impl/SceneGenerationFailureFacts'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { Agent } from '@infrastructure/ai/agents/Agent'
import { ExecutionBudget } from '@infrastructure/ai/execution/ExecutionBudget'
import { FinalizeRequested } from '@infrastructure/ai/execution/executionErrors'
import { recordWrittenFile } from '@infrastructure/ai/execution/writtenFileLedger'
import type { AiProjectFileSystemImpl } from '@infrastructure/ai/filesystem/AiProjectFileSystemImpl'
import type {
  WebGalSceneAgentInput,
  WebGalSceneAgentOutput
} from '@infrastructure/scene-generation/agents/WebGalSceneAgentTypes'
import { createWebGalGenerationGraph } from '@infrastructure/scene-generation/workflow/createWebGalGenerationGraph'
import { WebGalSceneGenerationWorkflowImpl } from '@infrastructure/scene-generation/workflow/WebGalSceneGenerationWorkflowImpl'
import { FileCheckpointSaver } from '@infrastructure/workflow/checkpoints/FileCheckpointSaver'
import { readDurableEffects } from '@infrastructure/workflow/execution/durableEffect'
import { langGraphThreadKey } from '@infrastructure/workflow/WorkflowIdentity'

const roots: string[] = []
const ENTRY = 'game/scene/start.txt'

configureDiagnosticHash((payload) =>
  createHash('sha256').update(payload).digest('hex').slice(0, 12)
)

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

type TerminalScenario = {
  name: string
  failureClass: FailureClass
  reason: SceneGenerationFailureReason
  code: number
  causeName: string
  /** 写入后保存修订失败，保留 started 供顺序断言。 */
  expectDurableEffect?: boolean
  saveRevisionFails?: boolean
  respond: (call: number, budget: ExecutionBudget) => WebGalSceneAgentOutput
}

const scenarios: readonly TerminalScenario[] = [
  {
    name: 'auth',
    failureClass: 'modelAuth',
    reason: 'modelAccess',
    code: ErrorCodes.forbidden,
    causeName: 'APIError',
    respond: () => {
      throw Object.assign(new Error('unauthorized'), { name: 'APIError', status: 401 })
    }
  },
  {
    name: 'request',
    failureClass: 'modelRejected',
    reason: 'modelRejected',
    code: ErrorCodes.invalidRequest,
    causeName: 'APIError',
    respond: () => {
      throw Object.assign(new Error('bad request'), { name: 'APIError', status: 400 })
    }
  },
  {
    name: 'context',
    failureClass: 'contextOverflow',
    reason: 'contextOverflow',
    code: ErrorCodes.invalidRequest,
    causeName: 'ContextWindowError',
    respond: () => {
      throw new AppException({
        code: ErrorCodes.invalidRequest,
        msg: '输入超出上下文窗口',
        diagnosticCategory: 'context',
        cause: Object.assign(new Error('context overflow'), { name: 'ContextWindowError' })
      })
    }
  },
  {
    name: 'transient',
    failureClass: 'modelTransient',
    reason: 'modelFailure',
    code: ErrorCodes.operationConflict,
    causeName: 'APIConnectionError',
    respond: (call) => {
      if (call === 1) throw new FinalizeRequested('noNewInformation')
      throw Object.assign(new Error('connection reset'), { name: 'APIConnectionError' })
    }
  },
  {
    name: 'internal',
    failureClass: 'internal',
    reason: 'modelFailure',
    code: ErrorCodes.internalError,
    causeName: 'ToolExecutionError',
    respond: () => {
      throw new AppException({
        code: ErrorCodes.internalError,
        msg: '工具执行失败',
        diagnosticCategory: 'tool',
        cause: Object.assign(new Error('tool failed'), { name: 'ToolExecutionError' })
      })
    }
  }
]

const orderingScenario: TerminalScenario = {
  name: 'ordering',
  failureClass: 'internal',
  reason: 'modelFailure',
  code: ErrorCodes.internalError,
  causeName: 'AggregateError',
  expectDurableEffect: true,
  saveRevisionFails: true,
  respond: (_call, budget) => {
    recordWrittenFile(budget, { path: ENTRY, version: 'write-1' })
    throw new AppException({
      code: ErrorCodes.internalError,
      msg: '工具执行失败',
      diagnosticCategory: 'tool',
      cause: Object.assign(new Error('tool failed'), { name: 'ToolExecutionError' })
    })
  }
}

it('五类终态保留公开原因、诊断编号和安全分类动作，不暴露诊断分类、状态和原因名', async () => {
  const references: string[] = []
  for (const scenario of scenarios) {
    const result = await runScenario(scenario)
    references.push(result.reference)
    expect(result.failure.failureClass).toBe(scenario.failureClass)
    expect(result.failure.reason).toBe(scenario.reason)
    expect(result.failure.code).toBe(scenario.code)
    expect(result.failure.causeName).toBe(scenario.causeName)
    expect(result.failure.diagnosticRef).toBe(result.reference)
    expect(result.publicFailure).toMatchObject({
      code: scenario.code,
      reason: scenario.reason,
      failureClass: scenario.failureClass,
      reference: result.reference
    })
    expect(result.publicFailure.nextActions).toEqual(result.failure.nextActions)
    expect('category' in result.publicFailure).toBe(false)
    expect('httpStatus' in result.publicFailure).toBe(false)
    expect('causeName' in result.publicFailure).toBe(false)
    expect(result.error).toBeInstanceOf(SceneGenerationRunFailed)
    expect(result.error.failureClass).toBe(scenario.failureClass)
    expect(result.error.cause).toBeDefined()
    expect(result.terminalPublishes).toBe(1)
  }
  expect(new Set(references).size).toBe(scenarios.length)
})

it('捕获顺序固定为检查点持久化、失败事实、副作用结算、唯一终态、公开错误', async () => {
  const scenario = orderingScenario
  const result = await runScenario(scenario)
  expect(result.events).toEqual(['checkpoint-failed', 'record-failure', 'settle', 'publish:settled'])
  expect(result.error).toBeInstanceOf(SceneGenerationRunFailed)
  expect(result.error.cause).toBeDefined()
})

async function runScenario(scenario: TerminalScenario): Promise<{
  error: SceneGenerationRunFailed
  failure: SceneGenerationFailureFact
  publicFailure: SceneGenerationPublicFailure
  reference: string
  terminalPublishes: number
  events: string[]
}> {
  const root = await mkdtemp(join(tmpdir(), `terminal-facts-${scenario.name}-`))
  roots.push(root)
  const initial = baseExecution(root)
  let current = initial
  const events: string[] = []
  const published: SceneGenerationWorkflowProgress[] = []
  const artifacts = {
    readCandidate: () => Promise.reject(new Error('终态失败用例不应读取候选')),
    saveCandidateRevision: () =>
      scenario.saveRevisionFails
        ? Promise.reject(new Error('revision unavailable'))
        : Promise.resolve({
            candidateSnapshotId: createHash('sha256').update(root).digest('hex')
          }),
    writeCandidateFiles: () => Promise.resolve({ candidateSnapshotId: 'edited' })
  }
  const deps = {
    stateRoot: root,
    saver: new FileCheckpointSaver(root),
    artifacts
  }
  let calls = 0
  const agent: Agent<WebGalSceneAgentInput, WebGalSceneAgentOutput> = {
    invoke: async (_input, execution) => {
      calls += 1
      return scenario.respond(calls, execution.context.budget)
    }
  }
  const runtime: SceneGenerationRuntime = {
    execution: initial,
    signal: new AbortController().signal,
    userAbortSignal: new AbortController().signal,
    activeTimeoutSignal: new AbortController().signal,
    publishProgress: async (progress) => {
      published.push(progress)
      if (progress.step === undefined) {
        if (scenario.expectDurableEffect) {
          const effects = await readDurableEffects(root, current)
          expect(effects.some((effect) => effect.status === 'started')).toBe(false)
          expect(effects).toContainEqual(expect.objectContaining({ status: 'failed' }))
        }
        events.push('settle', 'publish:settled')
      }
      current = {
        ...current,
        step: progress.step,
        budget: progress.budget,
        ...(progress.candidateSnapshotId
          ? { candidateSnapshotId: progress.candidateSnapshotId }
          : {})
      }
      return current
    },
    recordCandidateRevision: async (revision) => {
      current = { ...current, candidateSnapshotId: revision.candidateSnapshotId }
      return current
    },
    recordFailure: async (failure) => {
      const probe = createWebGalGenerationGraph(deps)
      const snapshot = await probe.getState({
        configurable: { thread_id: langGraphThreadKey(initial), checkpoint_ns: '' }
      })
      expect(snapshot.values.status).toBe('failed')
      expect(snapshot.values.failureClass).toBe(scenario.failureClass)
      expect(snapshot.values.execution.failure).toEqual(failure)
      if (scenario.expectDurableEffect) {
        const effects = await readDurableEffects(root, current)
        expect(effects.some((effect) => effect.status === 'started')).toBe(true)
      }
      events.push('checkpoint-failed', 'record-failure')
      current = { ...current, failure }
      return current
    }
  }
  const workflow = new WebGalSceneGenerationWorkflowImpl(
    deps,
    {} as AiProjectFileSystemImpl,
    async () => agent
  )
  const error = await workflow.executeGeneration(runtime).catch((reason) => reason)
  expect(error).toBeInstanceOf(SceneGenerationRunFailed)
  if (scenario.expectDurableEffect) {
    const effects = await readDurableEffects(root, current)
    expect(effects.some((effect) => effect.status === 'started')).toBe(false)
    expect(effects).toContainEqual(expect.objectContaining({ status: 'failed' }))
  }
  const failure = current.failure!
  const publicFailure = publicFailureOf(failure)
  const reference = failure.diagnosticRef!
  expect(reference).toMatch(/^[0-9a-f]{12}$/u)
  return {
    error: error as SceneGenerationRunFailed,
    failure,
    publicFailure,
    reference,
    terminalPublishes: published.filter(
      (progress) => progress.step === undefined
    ).length,
    events
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
    reviewCandidate: false,
    baseline: { commitId: 'base', affectedFiles: [], lockState: 'unlocked' },
    state: 'running',
    step: 'preparing',
    attempt: 0,
    sequence: 0,
    budget: { correctionsUsed: 0, modelCallsUsed: 0, toolCallsUsed: 0, activeElapsedMs: 0 },
    replies: [],
    workspace: { workspaceId: 'workspace-1', rootDirectory: root, sceneDirectory: 'game/scene' }
  }
}
