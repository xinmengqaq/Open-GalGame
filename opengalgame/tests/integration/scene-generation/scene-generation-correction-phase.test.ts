import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Command, isInterrupted } from '@langchain/langgraph'

import type { SceneGenerationRuntime } from '@application/scene-generation/models/SceneGenerationExecution'
import { safeSceneValidationIssueMessage } from '@application/scene-generation/mapping/SceneGenerationRenderProjection'
import type { SceneGenerationArtifact } from '@domain/scene-generation/models/SceneGenerationArtifact'
import { ExecutionBudget } from '@infrastructure/ai/execution/ExecutionBudget'
import { recordWrittenFile } from '@infrastructure/ai/execution/writtenFileLedger'
import { webGalGenerationCompatibility } from '@infrastructure/scene-generation/history/WebGalGenerationCheckpoint'
import {
  createWebGalGenerationGraph,
  generationInteraction
} from '@infrastructure/scene-generation/workflow/createWebGalGenerationGraph'
import type { WebGalSceneAgentInput } from '@infrastructure/scene-generation/agents/WebGalSceneAgentTypes'
import { FileCheckpointSaver } from '@infrastructure/workflow/checkpoints/FileCheckpointSaver'
import { langGraphThreadKey } from '@infrastructure/workflow/WorkflowIdentity'

const roots: string[] = []
const MIO_REAL_KEY = '64396666333032342d353666352d346233652d396331352d306237383566623162353838'
const MIO_WRONG_KEY = '64396666333032342d353666352d346233652d396331352d306237383566623162353538'

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('同一位置的可修正问题重复出现时进入错误预算，而不是一次就拒绝', async () => {
  const artifacts = Array.from({ length: 20 }, () => jump(0))
  const harness = await correctionHarness(artifacts)
  const first = await harness.graph.invoke(harness.input(), harness.config)
  expect(isInterrupted(first)).toBe(true)
  expect(harness.budget.errorAttempts).toBe(1)
  for (let round = 1; round <= 8; round += 1) {
    harness.live.execution = {
      ...harness.live.execution,
      pendingReply: {
        projectId: 'project1',
        sceneId: 'scene1',
        operationId: 'operation1',
        interactionId: `interaction-repeat-${round}`,
        replyId: `reply-repeat-${round}`,
        reply: { kind: 'revise', body: '继续处理同一处' }
      },
      replies: [
        {
          projectId: 'project1',
          sceneId: 'scene1',
          operationId: 'operation1',
          interactionId: `interaction-repeat-${round}`,
          replyId: `reply-repeat-${round}`,
          reply: { kind: 'revise', body: '继续处理同一处' }
        }
      ]
    }
    try {
      await harness.graph.invoke(new Command({ resume: `reply-repeat-${round}` }), harness.config)
    } catch (error) {
      expect(error).toMatchObject({ message: '错误调用保护次数已用尽' })
      break
    }
  }
  expect(harness.calls).toBeGreaterThan(1)
  expect(harness.calls).toBeLessThan(30)
  expect(harness.budget.errorAttempts).toBeGreaterThan(8)
})

it('同一说明出现在另一条语句上仍算有进展', async () => {
  const harness = await correctionHarness([jump(0), jump(4), spoken()])
  const result = await harness.graph.invoke(harness.input(), harness.config)
  expect(isInterrupted(result)).toBe(false)
  expect(harness.calls).toBe(2)
  expect(harness.budget.errorAttempts).toBe(0)
  const state = await harness.graph.getState(harness.config)
  expect(state.values.status).toBe('ready')
  expect(state.values.correctableIssueKey ?? '').toBe('')
})

it('校验通过并接受新的人工修改后，原来的问题可以再次自动修正', async () => {
  const harness = await correctionHarness([jump(0), spoken(), jump(0), spoken()], {
    reviewCandidate: true
  })
  const waiting = await harness.graph.invoke(harness.input(), harness.config)
  expect(isInterrupted(waiting)).toBe(true)
  const paused = await harness.graph.getState(harness.config)
  expect(paused.values.status).toBe('waiting')
  expect(paused.values.correctableIssueKey ?? '').toBe('')

  harness.live.execution = {
    ...harness.live.execution,
    pendingReply: {
      projectId: 'project1',
      sceneId: 'scene1',
      operationId: 'operation1',
      interactionId: 'interaction1',
      replyId: 'reply1',
      reply: { kind: 'revise', body: '去掉场景跳转' }
    },
    replies: [
      {
        projectId: 'project1',
        sceneId: 'scene1',
        operationId: 'operation1',
        interactionId: 'interaction1',
        replyId: 'reply1',
        reply: { kind: 'revise', body: '去掉场景跳转' }
      }
    ]
  }
  const resumed = await harness.graph.invoke(new Command({ resume: 'reply1' }), harness.config)
  expect(isInterrupted(resumed)).toBe(true)
  expect(harness.budget.errorAttempts).toBe(0)
  expect(harness.calls).toBe(3)
  const reviewed = await harness.graph.getState(harness.config)
  expect(reviewed.values.status).toBe('waiting')
  expect(reviewed.values.correctableIssueKey ?? '').toBe('')
})

it('连续对白缺少上下文时等待自然语言修正，再回到生成', async () => {
  const harness = await correctionHarness([continuousDialogue(), spoken()])
  const waiting = await harness.graph.invoke(harness.input(), harness.config)
  expect(isInterrupted(waiting)).toBe(true)
  expect(harness.calls).toBe(0)
  const paused = await harness.graph.getState(harness.config)
  expect(paused.values.needsDecision).toBe(true)
  expect(paused.values.execution.artifactValidation?.issues.map((issue) => issue.code)).toEqual(
    expect.arrayContaining(['missing-background', 'missing-character'])
  )
  const interaction = generationInteraction(paused.values, 'checkpoint-1')
  expect(interaction.kind).toBe('correction')
  expect(interaction.allowedReplies).toContain('revise')
  expect(interaction.message).toContain('连续对白缺少已建立的背景')
  expect(interaction.message).not.toContain(harness.live.execution.source.projectRoot)

  const reply = {
    projectId: 'project1',
    sceneId: 'scene1',
    operationId: 'operation1',
    interactionId: 'interaction1',
    replyId: 'reply-context',
    reply: { kind: 'revise' as const, body: '先补上车站背景和林的立绘' }
  }
  harness.live.execution = {
    ...harness.live.execution,
    pendingReply: reply,
    replies: [reply]
  }
  const resumed = await harness.graph.invoke(
    new Command({ resume: 'reply-context' }),
    harness.config
  )
  expect(isInterrupted(resumed)).toBe(false)
  expect(harness.calls).toBe(1)
  expect(harness.invocations[0]?.mode).toBe('repair')
  expect(harness.invocations[0]?.confirmedReplies).toEqual([
    expect.objectContaining({ reply: { kind: 'revise', body: '先补上车站背景和林的立绘' } })
  ])
  expect(harness.invocations[0]?.candidate?.preview.validationReport.issues).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: 'missing-background' })])
  )
})

it('缺失素材诊断带出错引用、入口行号与最近似有效引用进入修正轮', async () => {
  const harness = await correctionHarness([missingFigure(), spoken()])
  harness.live.execution = {
    ...harness.live.execution,
    inputSnapshot: {
      ...harness.live.execution.inputSnapshot,
      assets: [
        {
          assetId: 'mio',
          sourceId: 'mio-source',
          name: '澪',
          relativePath: `assets/${MIO_REAL_KEY}/josei_01_a.png`,
          category: 'image',
          description: '立绘',
          usage: { targetIds: [] }
        }
      ]
    }
  }

  const result = await harness.graph.invoke(harness.input(), harness.config)

  expect(isInterrupted(result)).toBe(false)
  expect(harness.calls).toBe(1)
  expect(harness.invocations[0]?.candidate?.preview.validationReport.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        code: 'missing-asset',
        reference: `${MIO_WRONG_KEY}/josei_01_a.png`,
        line: 9,
        nearestReference: `${MIO_REAL_KEY}/josei_01_a.png`,
        nearestAssetName: '澪',
        nearestAssetPath: `assets/${MIO_REAL_KEY}/josei_01_a.png`
      })
    ])
  )
  const state = await harness.graph.getState(harness.config)
  expect(state.values.status).toBe('ready')
})

it('自动修正达到上限后等待人工，不再调用模型', async () => {
  const harness = await correctionHarness([jump(0), jump(4), jump(8), spoken()])
  const waiting = await harness.graph.invoke(harness.input(), harness.config)
  expect(isInterrupted(waiting)).toBe(true)
  expect(harness.calls).toBe(2)
  const paused = await harness.graph.getState(harness.config)
  expect(paused.values.status).toBe('waiting')
  expect(paused.values.needsDecision).toBe(true)
  expect(paused.values.execution.budget.correctionsUsed).toBe(2)
  expect(paused.values.execution.candidateSnapshotId).toMatch(/^[0-9a-f]{64}$/u)
  const interaction = generationInteraction(paused.values, 'checkpoint-cap')
  expect(interaction.kind).toBe('correction')
  expect(interaction.allowedReplies).toEqual(expect.arrayContaining(['revise', 'discard']))
  expect(interaction.allowedReplies).not.toContain('accept')
  expect(interaction.message).toContain('已自动修正 2 次')
  const issues = paused.values.execution.artifactValidation?.issues ?? []
  expect(issues.length).toBeGreaterThan(0)
  for (const issue of issues) {
    const message = safeSceneValidationIssueMessage(issue.code)
    if (message) expect(interaction.message).toContain(message)
  }
})

it('旧检查点缺少修正次数时按已耗尽等待，不重新开始自动修正', async () => {
  const harness = await correctionHarness([jump(0)])
  harness.live.execution = {
    ...harness.live.execution,
    budget: {
      ...harness.live.execution.budget,
      correctionsUsed: undefined as unknown as number
    }
  }
  const waiting = await harness.graph.invoke(harness.input(), harness.config)
  expect(isInterrupted(waiting)).toBe(true)
  expect(harness.calls).toBe(0)
  const paused = await harness.graph.getState(harness.config)
  expect(paused.values.status).toBe('waiting')
  expect(paused.values.needsDecision).toBe(true)
  const interaction = generationInteraction(paused.values, 'checkpoint-legacy')
  expect(interaction.kind).toBe('correction')
  expect(interaction.message).toContain('已自动修正 2 次')
})

it('相同问题先达到自动修正上限，不进入错误预算', async () => {
  const harness = await correctionHarness([jump(0), jump(0), jump(0)])
  const waiting = await harness.graph.invoke(harness.input(), harness.config)
  expect(isInterrupted(waiting)).toBe(true)
  expect(harness.calls).toBe(2)
  expect(harness.budget.errorAttempts).toBe(1)
  const paused = await harness.graph.getState(harness.config)
  expect(paused.values.execution.budget.correctionsUsed).toBe(2)
  expect(paused.values.execution.candidateSnapshotId).toBe(
    harness.live.execution.candidateSnapshotId
  )
})

it('用户提出修改后自动修正次数重新从零开始', async () => {
  const harness = await correctionHarness([jump(0), jump(4), jump(8), jump(1), jump(2), spoken()], {
    reviewCandidate: true
  })
  const capped = await harness.graph.invoke(harness.input(), harness.config)
  expect(isInterrupted(capped)).toBe(true)
  expect(harness.calls).toBe(2)
  harness.live.execution = {
    ...harness.live.execution,
    pendingReply: {
      projectId: 'project1',
      sceneId: 'scene1',
      operationId: 'operation1',
      interactionId: 'interaction-cap',
      replyId: 'reply-cap',
      reply: { kind: 'revise', body: '再改一次跳转' }
    },
    replies: [
      {
        projectId: 'project1',
        sceneId: 'scene1',
        operationId: 'operation1',
        interactionId: 'interaction-cap',
        replyId: 'reply-cap',
        reply: { kind: 'revise', body: '再改一次跳转' }
      }
    ]
  }
  const resumed = await harness.graph.invoke(new Command({ resume: 'reply-cap' }), harness.config)
  expect(isInterrupted(resumed)).toBe(true)
  expect(harness.calls).toBe(5)
  const reviewed = await harness.graph.getState(harness.config)
  expect(reviewed.values.execution.budget.correctionsUsed).toBe(2)
  expect(reviewed.values.execution.candidateSnapshotId).toMatch(/^[0-9a-f]{64}$/u)
})

async function correctionHarness(
  artifacts: readonly SceneGenerationArtifact[],
  options: { reviewCandidate?: boolean } = {}
): Promise<{
  graph: ReturnType<typeof createWebGalGenerationGraph>
  budget: ExecutionBudget
  config: { configurable: { thread_id: string; checkpoint_ns: string }; recursionLimit: number }
  calls: number
  invocations: WebGalSceneAgentInput[]
  live: { execution: SceneGenerationRuntime['execution'] }
}> {
  const root = await mkdtemp(join(tmpdir(), 'correction-phase-'))
  roots.push(root)
  const calls = { count: 0 }
  const invocations: WebGalSceneAgentInput[] = []
  let cursor = 0
  const execution = {
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
    reviewCandidate: options.reviewCandidate === true,
    baseline: { commitId: 'base', affectedFiles: [], lockState: 'unlocked' as const },
    state: 'running' as const,
    step: 'validating' as const,
    attempt: 0,
    sequence: 0,
    budget: { correctionsUsed: 0, modelCallsUsed: 0, toolCallsUsed: 0, activeElapsedMs: 0 },
    replies: [],
    candidateSnapshotId: 'a'.repeat(40),
    workspace: { workspaceId: 'workspace-1', rootDirectory: root, sceneDirectory: 'game/scene' }
  }
  const live = { execution }
  const budget = new ExecutionBudget({ modelAttempts: 32, toolCalls: 32, activeMs: 900000 })
  const preview = {
    entryFile: 'game/scene/start.txt',
    files: ['game/scene/start.txt'],
    parserVersion: '4.6.5',
    commandLocations: [],
    assetLocations: [],
    validationReport: { issues: [] }
  }
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
    agent: {
      invoke: (input) => {
        invocations.push(input)
        calls.count += 1
        recordWrittenFile(budget, { path: 'game/scene/start.txt', version: `write-${calls.count}` })
        return Promise.resolve({
          summary: '已修改候选',
          writtenFiles: ['game/scene/start.txt'],
          usedAssetIds: [],
          unresolvedIssues: [],
          tradeoffs: [],
          memoryMessages: []
        })
      }
    },
    artifacts: {
      readCandidate: () => {
        const artifact = artifacts[Math.min(cursor, artifacts.length - 1)]!
        cursor += 1
        return Promise.resolve({
          candidateSnapshotId: createHash('sha256').update(`read-${cursor}`).digest('hex'),
          artifact,
          preview,
          assetChanges: []
        })
      },
      saveCandidateRevision: () =>
        Promise.resolve({
          candidateSnapshotId: createHash('sha256').update(`saved-${calls.count}`).digest('hex')
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
    budget,
    config,
    get calls() {
      return calls.count
    },
    invocations,
    live,
    input: () => ({
      execution: live.execution,
      mode: 'validate',
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

function missingFigure(): SceneGenerationArtifact {
  return {
    scene: { projectId: 'project1', sceneId: 'scene1' },
    hasEntry: true,
    statements: [
      {
        sequence: 0,
        command: 'changeFigure',
        commandRecognition: 'recognized',
        argumentRecognition: 'recognized',
        content: `changeFigure:${MIO_WRONG_KEY}/josei_01_a.png -id=澪;`,
        assetUses: [
          {
            category: 'image',
            outcome: 'missing',
            reference: `${MIO_WRONG_KEY}/josei_01_a.png`,
            line: 9
          }
        ]
      }
    ]
  }
}

function jump(sequence: number): SceneGenerationArtifact {
  return {
    scene: { projectId: 'project1', sceneId: 'scene1' },
    hasEntry: true,
    statements: [
      {
        sequence,
        command: 'changeScene',
        commandRecognition: 'recognized',
        argumentRecognition: 'recognized',
        content: 'next.txt',
        assetUses: []
      }
    ]
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

function continuousDialogue(): SceneGenerationArtifact {
  return {
    scene: { projectId: 'project1', sceneId: 'scene1' },
    hasEntry: true,
    statements: [
      {
        sequence: 0,
        command: 'say',
        commandRecognition: 'recognized',
        argumentRecognition: 'recognized',
        content: '第一句',
        assetUses: [],
        dialogueSpeaker: 'explicit',
        waitsForPlayer: true
      },
      {
        sequence: 1,
        command: 'say',
        commandRecognition: 'recognized',
        argumentRecognition: 'recognized',
        content: '第二句',
        assetUses: [],
        dialogueSpeaker: 'inherited',
        waitsForPlayer: true
      }
    ]
  }
}
