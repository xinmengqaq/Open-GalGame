import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { SceneGenerationExecution } from '@application/scene-generation/models/SceneGenerationExecution'
import type { WebGalGenerationStateValue } from '@infrastructure/scene-generation/workflow/WebGalGenerationState'
import { createWebGalGenerationGraph } from '@infrastructure/scene-generation/workflow/createWebGalGenerationGraph'
import { WebGalGenerationCheckpointSaver } from '@infrastructure/scene-generation/history/WebGalGenerationCheckpoint'
import { langGraphThreadKey } from '@infrastructure/workflow/WorkflowIdentity'
import {
  generationFixture,
  request,
  type GenerationFixture
} from '../../../../harness/acceptance/support/generationFixture'

function graphOf(f: GenerationFixture) {
  const stateRoot = join(f.config.userStateRoot, 'ai')
  return createWebGalGenerationGraph({
    stateRoot,
    saver: new WebGalGenerationCheckpointSaver(stateRoot),
    artifacts: f.app.ports.artifacts
  })
}

async function checkpointsOf(
  f: GenerationFixture,
  execution: SceneGenerationExecution
): Promise<Array<{ checkpointId: string; values: Partial<WebGalGenerationStateValue> }>> {
  const history: Array<{ checkpointId: string; values: Partial<WebGalGenerationStateValue> }> = []
  for await (const snapshot of graphOf(f).getStateHistory({
    configurable: { thread_id: langGraphThreadKey(execution), checkpoint_ns: '' }
  })) {
    const checkpointId = snapshot.config.configurable?.checkpoint_id
    if (typeof checkpointId !== 'string') continue
    history.push({
      checkpointId,
      values: snapshot.values as Partial<WebGalGenerationStateValue>
    })
  }
  return history.reverse()
}

async function initialStateOf(
  f: GenerationFixture,
  execution: SceneGenerationExecution
): Promise<Partial<WebGalGenerationStateValue>> {
  const first = (await checkpointsOf(f, execution)).find(
    (entry) => entry.values.execution?.operationId === execution.operationId
  )
  expect(first).toBeDefined()
  return first!.values
}

async function poisonCheckpoint(
  f: GenerationFixture,
  execution: SceneGenerationExecution,
  values: Record<string, unknown>
): Promise<string> {
  const updated = await graphOf(f).updateState(
    { configurable: { thread_id: langGraphThreadKey(execution) } },
    values
  )
  return String(updated.configurable!.checkpoint_id)
}

const legacyRuntimeFields = {
  retryCount: 2,
  finalizeCount: 3,
  repairRequested: true,
  blockedReason: '旧阻塞原因',
  failureClass: 'modelTransient' as const,
  failureReason: 'transient' as const,
  failureMessage: '旧失败消息',
  writtenFiles: ['game/scene/old.txt'],
  correctableIssueKey: 'old-correction-signature',
  summaryDegraded: true,
  outcome: { kind: 'blocked' as const, reason: '旧结果', processable: true as const },
  status: 'waiting' as const,
  needsDecision: true
}

const retainedContext = {
  summary: '保留摘要',
  unresolvedIssues: ['保留问题'],
  memoryMessages: [{ id: 'old-memory', role: 'user' as const, content: '保留记忆' }],
  questions: [
    {
      questionId: 'q1',
      prompt: '保留哪一段？',
      options: [
        { id: 'q1o1', label: '第一段', description: '保留第一段。' },
        { id: 'q1o2', label: '第二段', description: '保留第二段。' },
        { id: 'q1o3', label: '都保留', description: '两段都保留。' }
      ]
    }
  ]
}

function replyFact(execution: SceneGenerationExecution) {
  return {
    projectId: execution.projectId,
    sceneId: execution.sceneId,
    operationId: execution.operationId,
    threadId: execution.threadId,
    branchId: execution.branchId,
    interactionId: 'old-interaction',
    checkpointId: 'old-checkpoint',
    replyId: 'old-reply',
    reply: { kind: 'clarify' as const, body: '保留原样' }
  }
}

it('同线程新操作从清零运行态开始，不继承旧重试、阻塞、写入与摘要降级', async () => {
  const f = await generationFixture()
  await f.app.generation.generateScene(request)
  await f.run()
  const previous = (await f.app.ports.executions.readExecution(request))!
  await poisonCheckpoint(f, previous, {
    ...legacyRuntimeFields,
    ...retainedContext,
    confirmedReplies: [replyFact(previous)]
  })
  const start = f.bodies.length
  const second = { ...request, operationId: 'operation-second' }
  await f.app.generation.generateScene({
    ...second,
    branch: { threadId: previous.threadId, branchId: previous.branchId }
  })
  await f.run()

  const status = await f.app.status.getSceneGenerationStatus(second)
  expect(status.state).toBe('succeeded')
  const execution = (await f.app.ports.executions.readExecution(second))!
  const initial = await initialStateOf(f, execution)
  expect(initial.execution?.operationId).toBe('operation-second')
  expect(initial.status).toBe('working')
  expect(initial.needsDecision).toBe(false)
  expect(initial.outcome).toBeUndefined()
  expect(initial.retryCount).toBe(0)
  expect(initial.finalizeCount).toBe(0)
  expect(initial.repairRequested).toBe(false)
  expect(initial.blockedReason).toBeUndefined()
  expect(initial.failureClass).toBeUndefined()
  expect(initial.failureReason).toBeUndefined()
  expect(initial.failureMessage).toBeUndefined()
  expect(initial.writtenFiles).toEqual([])
  expect(initial.correctableIssueKey).toBeUndefined()
  expect(initial.summaryDegraded).toBeUndefined()

  expect(initial.summary).toBe('保留摘要')
  expect(initial.unresolvedIssues).toEqual(['保留问题'])
  expect(initial.memoryMessages).toEqual(retainedContext.memoryMessages)
  expect(initial.questions).toEqual(retainedContext.questions)
  expect(initial.confirmedReplies).toHaveLength(1)
  expect(initial.confirmedReplies?.[0]?.replyId).toBe('old-reply')

  const requests = f.bodies.slice(start).map((body) => JSON.stringify(body.messages))
  expect(requests.length).toBeGreaterThan(0)
  for (const body of requests) {
    expect(body).not.toContain('game/scene/old.txt')
    expect(body).not.toContain('旧阻塞原因')
    expect(body).not.toContain('旧失败消息')
  }
  expect(requests.some((body) => body.includes('候选：未写出'))).toBe(true)
}, 30000)

it('分叉保留已确认上下文与候选，但不继承旧运行字段', async () => {
  const f = await generationFixture({ reviewCandidate: true })
  const operation = await f.app.generation.generateScene(request)
  await f.run()
  const source = (await f.app.ports.executions.readExecution(request))!
  expect(source.candidateSnapshotId).toBeTruthy()
  const checkpointId = await poisonCheckpoint(f, source, {
    ...legacyRuntimeFields,
    ...retainedContext,
    confirmedReplies: [replyFact(source)]
  })
  const fork = { ...operation, operationId: 'fork-initial-state' }
  await f.app.generation.forkSceneGeneration({
    ...fork,
    checkpointId,
    policy: request.policy
  })
  await f.run()

  const execution = (await f.app.ports.executions.readExecution(fork))!
  const initial = await initialStateOf(f, execution)
  expect(initial.execution?.operationId).toBe('fork-initial-state')
  expect(initial.status).toBe('working')
  expect(initial.needsDecision).toBe(false)
  expect(initial.outcome).toBeUndefined()
  expect(initial.retryCount).toBe(0)
  expect(initial.finalizeCount).toBe(0)
  expect(initial.repairRequested).toBe(false)
  expect(initial.blockedReason).toBeUndefined()
  expect(initial.failureClass).toBeUndefined()
  expect(initial.failureReason).toBeUndefined()
  expect(initial.failureMessage).toBeUndefined()
  expect(initial.correctableIssueKey).toBeUndefined()
  expect(initial.summaryDegraded).toBeUndefined()
  expect(initial.writtenFiles).toEqual(['game/scene/start.txt'])

  expect(initial.summary).toBe('保留摘要')
  expect(initial.unresolvedIssues).toEqual(['保留问题'])
  expect(initial.memoryMessages).toEqual(retainedContext.memoryMessages)
  // D2：候选存在时旧题组一律失效，初始化不再携带旧题。
  expect(initial.questions).toEqual([])
  expect(initial.confirmedReplies?.[0]?.replyId).toBe('old-reply')
  expect(initial.candidate?.candidateSnapshotId).toBe(source.candidateSnapshotId)

  expect(execution.candidateSnapshotId).toBe(source.candidateSnapshotId)
  // 旧等待记录恢复后也不投影旧题组。
  expect(execution.interaction?.kind).toBe('clarification')
  expect(execution.interaction?.questions ?? []).toEqual([])
}, 30000)

it('旧检查点缺少运行字段时新操作按清零语义继续', async () => {
  const f = await generationFixture()
  await f.app.generation.generateScene(request)
  await f.run()
  const previous = (await f.app.ports.executions.readExecution(request))!
  await poisonCheckpoint(f, previous, {
    retryCount: undefined,
    finalizeCount: undefined,
    repairRequested: undefined,
    blockedReason: undefined,
    failureClass: undefined,
    failureReason: undefined,
    failureMessage: undefined,
    writtenFiles: undefined,
    correctableIssueKey: undefined,
    summaryDegraded: undefined,
    outcome: undefined,
    status: 'waiting'
  })
  const second = { ...request, operationId: 'operation-legacy-checkpoint' }
  await f.app.generation.generateScene({
    ...second,
    branch: { threadId: previous.threadId, branchId: previous.branchId }
  })
  await f.run()

  expect((await f.app.status.getSceneGenerationStatus(second)).state).toBe('succeeded')
  const execution = (await f.app.ports.executions.readExecution(second))!
  const initial = await initialStateOf(f, execution)
  expect(initial.status).toBe('working')
  expect(initial.needsDecision).toBe(false)
  expect(initial.retryCount).toBe(0)
  expect(initial.finalizeCount).toBe(0)
  expect(initial.repairRequested).toBe(false)
  expect(initial.writtenFiles).toEqual([])
  expect(initial.outcome).toBeUndefined()
  expect(initial.blockedReason).toBeUndefined()
  expect(initial.failureClass).toBeUndefined()
  expect(initial.failureReason).toBeUndefined()
  expect(initial.failureMessage).toBeUndefined()
  expect(initial.correctableIssueKey).toBeUndefined()
  expect(initial.summaryDegraded).toBeUndefined()
}, 30000)
