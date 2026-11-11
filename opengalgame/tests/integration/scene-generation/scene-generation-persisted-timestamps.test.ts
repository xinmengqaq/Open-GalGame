import { afterEach, expect, it } from 'vitest'

import type { SceneGenerationRenderProgressEventVO } from '@application/scene-generation/vo/SceneGenerationRenderVO'
import {
  ageStoredTimes,
  cleanupHarnessRoots,
  createHarness,
  executionFact,
  replyRequest,
  request,
  staleUpdatedAt,
  waitingOutcome
} from './scene-generationPersistedTimestampsFixture'

afterEach(cleanupHarnessRoots)

it('开始路径的失败事件取仓库写回时间', async () => {
  const harness = await createHarness()
  harness.workflow.executeGeneration.mockImplementationOnce(async (runtime) => {
    await runtime.publishProgress({
      step: 'generating',
      attempt: 1,
      budget: { correctionsUsed: 0, modelCallsUsed: 1, toolCallsUsed: 0, activeElapsedMs: 0 }
    })
    throw new Error('模型调用失败')
  })
  const events: SceneGenerationRenderProgressEventVO[] = []
  harness.coordinator.subscribeRenderProgress(request, (event) => events.push(event))

  await harness.service.generateScene(request)
  await expect(harness.runNext()).rejects.toThrow('模型调用失败')

  const saved = (await harness.repository.readExecution(request))!
  const failure = events.at(-1)!
  expect(saved.state).toBe('failed')
  expect(saved.createdAt).toBeTypeOf('string')
  expect(saved.updatedAt).toBeTypeOf('string')
  expect(failure.state).toBe('failed')
  expect(failure.updatedAt).toBe(saved.updatedAt)
})

it('回复后的实时事件使用本次写回时间并保留创建时间', async () => {
  const harness = await createHarness()
  harness.workflow.executeGeneration.mockResolvedValueOnce(waitingOutcome())
  harness.workflow.continueInteraction.mockImplementationOnce(async () => {
    throw new Error('回复执行失败')
  })
  await harness.service.generateScene(request)
  await harness.runNext()
  const waiting = (await harness.repository.readExecution(request))!
  expect(waiting.state).toBe('waiting')
  const createdAt = waiting.createdAt!
  await ageStoredTimes(harness.stateRoot, staleUpdatedAt)

  const aged = (await harness.repository.readExecution(request))!
  expect(aged.updatedAt).toBe(staleUpdatedAt)
  const events: SceneGenerationRenderProgressEventVO[] = []
  harness.coordinator.subscribeRenderProgress(request, (event) => events.push(event))

  const receipt = await harness.service.replySceneGenerationInteraction(replyRequest(aged))
  expect(receipt.accepted).toBe(true)
  await expect(harness.runNext()).rejects.toThrow('回复执行失败')

  const saved = (await harness.repository.readExecution(request))!
  const failure = events.at(-1)!
  expect(saved.createdAt).toBe(createdAt)
  expect(saved.updatedAt).not.toBe(staleUpdatedAt)
  expect(failure.updatedAt).toBe(saved.updatedAt)
  expect(failure.updatedAt).not.toBe(staleUpdatedAt)
})

it('恢复后的实时事件和返回状态取本次写回记录', async () => {
  const harness = await createHarness()
  const createdAt = '2026-10-01T00:00:00.000Z'
  await harness.repository.createExecution({
    ...executionFact(),
    state: 'interrupted',
    step: undefined,
    interruptReason: 'paused',
    checkpointId: 'checkpoint-1',
    candidateSnapshotId: 'snapshot-1',
    createdAt
  })
  await ageStoredTimes(harness.stateRoot, staleUpdatedAt)
  harness.workflow.resumeGeneration.mockImplementationOnce(async () => {
    throw new Error('恢复执行失败')
  })
  const events: SceneGenerationRenderProgressEventVO[] = []
  harness.coordinator.subscribeRenderProgress(request, (event) => events.push(event))

  const status = await harness.service.resumeAuthorizedPause(request)
  const resumed = (await harness.repository.readExecution(request))!
  expect(status.state).toBe('pending')
  expect(status.sequence).toBe(resumed.sequence)
  await expect(harness.runNext()).rejects.toThrow('恢复执行失败')

  const saved = (await harness.repository.readExecution(request))!
  const failure = events.at(-1)!
  expect(saved.createdAt).toBe(createdAt)
  expect(saved.updatedAt).not.toBe(staleUpdatedAt)
  expect(failure.state).toBe('failed')
  expect(failure.updatedAt).toBe(saved.updatedAt)
  expect(failure.updatedAt).not.toBe(staleUpdatedAt)
})

it('仓库写入失败不发布未持久化事件', async () => {
  const harness = await createHarness()
  const events: SceneGenerationRenderProgressEventVO[] = []
  harness.coordinator.subscribeRenderProgress(request, (event) => events.push(event))
  const published = harness.progress.length

  await expect(
    harness.coordinator.writeExecution({ ...executionFact(), projectId: '../escaped' })
  ).rejects.toThrow()
  expect(harness.progress).toHaveLength(published)
  expect(events).toHaveLength(0)
  await expect(harness.repository.readExecution(request)).resolves.toBeNull()
})
