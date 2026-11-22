import { expect, it } from 'vitest'
import { createSceneGeneration } from '@bootstrap/sceneGeneration'
import { generationFixture, request } from '../../../../harness/acceptance/support/generationFixture'

it('真实装配的安全暂停在重开后不自动调模型，显式继续从原操作生成一次', async () => {
  const f = await generationFixture()
  const operation = await f.app.generation.generateScene(request)

  // 生成任务已进入活动表但尚未开始模型往返：此时暂停必须等到安全检查点，且留下可恢复边界。
  await f.app.control.pauseSceneGeneration(request)
  await f.run()

  const paused = (await f.app.ports.executions.readExecution(request))!
  expect(paused.state).toBe('interrupted')
  expect(paused.interruptReason).toBe('paused')
  expect(paused.checkpointId).toBeDefined()
  expect(paused.candidateSnapshotId).toBeUndefined()
  expect(f.bodies).toHaveLength(0)
  const pausedStatus = await f.app.status.getSceneGenerationStatus(request)
  expect(pausedStatus.canResume).toBe(true)

  // 重开：新装配实例只读取状态与检查点，不得自动创建模型请求。
  const reopened = await createSceneGeneration({ ...f.config })
  const checkpoint = await reopened.ports.history.readCheckpoint({
    projectId: operation.projectId,
    sceneId: operation.sceneId,
    threadId: operation.threadId,
    branchId: operation.branchId,
    checkpointId: paused.checkpointId!
  })
  expect(checkpoint.view.canContinue).toBe(true)
  expect(f.bodies).toHaveLength(0)
  const reopenedStatus = await reopened.status.getSceneGenerationStatus(request)
  expect(reopenedStatus.canResume).toBe(true)
  const pausedDiscovery = await reopened.renderQuery.listUnfinishedSceneGenerations({
    projectId: request.projectId,
    sceneId: request.sceneId,
    limit: 100
  })
  const discoveredPause = pausedDiscovery.items.find(
    (item) => item.operationId === paused.operationId
  )
  expect(discoveredPause).toMatchObject({
    state: 'interrupted',
    checkpointId: paused.checkpointId,
    blocksNewGeneration: true
  })
  // 进入发现列表不等于获得“无检查点继续”或“待核对”资格。
  expect(discoveredPause?.canResumeUnfinished).toBeUndefined()
  expect(discoveredPause?.canVerifyResult).toBeUndefined()

  // 用户明确继续：核对暂停检查点身份后，从原操作的安全点开始生成一次。
  await reopened.control.resumeSceneGeneration({
    projectId: operation.projectId,
    sceneId: operation.sceneId,
    operationId: operation.operationId,
    threadId: operation.threadId,
    branchId: operation.branchId,
    checkpointId: paused.checkpointId!,
    candidateSnapshotId: paused.candidateSnapshotId
  })
  await f.run()

  const resumed = (await reopened.ports.executions.readExecution(request))!
  expect(resumed.state).toBe('waiting')
  expect(resumed.candidateSnapshotId).toMatch(/^[0-9a-f]{40}$/u)
  expect(resumed.attempt).toBe(paused.attempt + 1)
  expect(f.bodies.length).toBeGreaterThan(0)
  const settledRequestCount = f.bodies.length

  // 重复恢复同一暂停身份：身份已过期，不再排队、不再调用模型或写候选。
  await expect(
    reopened.control.resumeSceneGeneration({
      projectId: operation.projectId,
      sceneId: operation.sceneId,
      operationId: operation.operationId,
      threadId: operation.threadId,
      branchId: operation.branchId,
      checkpointId: paused.checkpointId!,
      candidateSnapshotId: paused.candidateSnapshotId
    })
  ).rejects.toMatchObject({ code: 4103 })
  expect(f.jobs).toHaveLength(0)
  expect(f.bodies).toHaveLength(settledRequestCount)
  expect((await reopened.ports.executions.readExecution(request))!.candidateSnapshotId).toBe(
    resumed.candidateSnapshotId
  )
})
