import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createSceneGeneration } from '@bootstrap/sceneGeneration'
import type { ReplySceneGenerationInteractionDTO } from '@application/scene-generation/dto/SceneGenerationDTO'
import type { SceneGenerationStatusVO } from '@application/scene-generation/vo/SceneGenerationVO'
import { readPauseBoundary } from '@infrastructure/scene-generation/pi/PiPauseBoundary'
import {
  generationFixture,
  request,
  validScript,
  type GenerationFixture
} from '../../../../harness/acceptance/support/generationFixture'

const entryPath = 'game/scene/start.txt'

type WaitingReview = {
  f: GenerationFixture
  waiting: SceneGenerationStatusVO
  reply: ReplySceneGenerationInteractionDTO
}

async function waitingReview(): Promise<WaitingReview> {
  const f = await generationFixture()
  await f.app.generation.generateScene({ ...request, reviewCandidate: true })
  await f.run()
  const waiting = await f.app.status.getSceneGenerationStatus(request)
  expect(waiting.state).toBe('waiting')
  const reply = {
    projectId: waiting.projectId,
    sceneId: waiting.sceneId,
    operationId: waiting.operationId,
    threadId: waiting.threadId,
    branchId: waiting.branchId,
    interactionId: waiting.interaction!.interactionId,
    checkpointId: waiting.interaction!.checkpointId,
    candidateSnapshotId: waiting.interaction!.candidateSnapshotId,
    replyId: 'reply-accept-gate',
    reply: { kind: 'accept' as const }
  }
  return { f, waiting, reply }
}

/** 在提交复核读取基线时停住，让暂停在不可撤销提交之前受理。 */
async function fenceValidating(): Promise<
  WaitingReview & { running: Promise<void>; release: () => void }
> {
  const f = await waitingReview()
  const versions = f.f.app.ports.versions
  const original = versions.inspectBaseline.bind(versions)
  const reached = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  let calls = 0
  versions.inspectBaseline = async (execution) => {
    calls += 1
    // 第 1 次在回复受理、第 2 次在恢复执行；第 3 次才是提交前复核。
    if (calls === 3) {
      reached.resolve()
      await released.promise
    }
    return original(execution)
  }
  await f.f.app.generation.replySceneGenerationInteraction(f.reply)
  const job = f.f.jobs.shift()
  if (!job) throw new Error('缺少接受任务')
  const running = job()
  await reached.promise
  return { ...f, running, release: () => released.resolve() }
}

it('提交前已受理暂停：保留接受候选与可恢复边界，重开显式继续只提交一次', async () => {
  const f = await fenceValidating()
  const baseline = f.f.git('rev-parse', 'HEAD')
  const baselineCount = f.f.git('rev-list', '--count', 'HEAD')
  const bodies = f.f.bodies.length

  const paused = await f.f.app.control.pauseSceneGeneration(request)
  expect(paused.state).toBe('running')
  f.release()
  await f.running

  const stored = (await f.f.app.ports.executions.readExecution(request))!
  expect(stored.state).toBe('interrupted')
  expect(stored.interruptReason).toBe('paused')
  expect(stored.pauseRequested).toBe(false)
  expect(stored.checkpointId).toBeDefined()
  expect(stored.candidateSnapshotId).toBe(f.waiting.interaction!.candidateSnapshotId)
  expect(await readFile(join(f.f.projectRoot, entryPath), 'utf8')).toBe('say:原稿;')
  expect(f.f.git('rev-parse', 'HEAD')).toBe(baseline)
  expect(f.f.git('rev-list', '--count', 'HEAD')).toBe(baselineCount)
  expect(f.f.bodies).toHaveLength(bodies)
  const boundary = await readPauseBoundary(
    join(f.f.root, 'state/ai'),
    stored
  )
  expect(boundary).toMatchObject({
    reviewAccepted: true,
    candidateSnapshotId: stored.candidateSnapshotId,
    generation: stored.attempt
  })

  // 重开只读取状态与边界，不自动调用模型或提交。
  const reopened = await createSceneGeneration({ ...f.f.config })
  expect(f.f.bodies).toHaveLength(bodies)
  const checkpoint = await reopened.ports.history.readCheckpoint({
    projectId: stored.projectId,
    sceneId: stored.sceneId,
    threadId: stored.threadId,
    branchId: stored.branchId,
    checkpointId: stored.checkpointId!
  })
  expect(checkpoint.view.canContinue).toBe(true)

  await reopened.control.resumeSceneGeneration({
    projectId: stored.projectId,
    sceneId: stored.sceneId,
    operationId: stored.operationId,
    threadId: stored.threadId,
    branchId: stored.branchId,
    checkpointId: stored.checkpointId!,
    candidateSnapshotId: stored.candidateSnapshotId
  })
  const resumeJob = f.f.jobs.shift()
  if (!resumeJob) throw new Error('缺少继续任务')
  await resumeJob()

  const finished = (await reopened.ports.executions.readExecution(request))!
  expect(finished.state).toBe('succeeded')
  expect(finished.result?.commitId).toBeTruthy()
  expect(f.f.bodies).toHaveLength(bodies)
  expect(await readFile(join(f.f.projectRoot, entryPath), 'utf8')).toBe(validScript)
  expect(f.f.git('rev-parse', 'HEAD')).toBe(finished.result?.commitId)
  expect(f.f.git('rev-list', '--count', 'HEAD')).toBe(
    String(Number(baselineCount) + 1)
  )
  expect(await readPauseBoundary(join(f.f.root, 'state/ai'), stored)).toBeNull()

  const settledBodies = f.f.bodies.length
  await expect(
    reopened.control.resumeSceneGeneration({
      projectId: stored.projectId,
      sceneId: stored.sceneId,
      operationId: stored.operationId,
      threadId: stored.threadId,
      branchId: stored.branchId,
      checkpointId: stored.checkpointId!,
      candidateSnapshotId: stored.candidateSnapshotId
    })
  ).rejects.toMatchObject({ code: 4103 })
  expect(f.f.jobs).toHaveLength(0)
  expect(f.f.bodies).toHaveLength(settledBodies)
  expect(f.f.git('rev-parse', 'HEAD')).toBe(finished.result?.commitId)
  expect(f.f.git('rev-list', '--count', 'HEAD')).toBe(
    String(Number(baselineCount) + 1)
  )
}, 30000)

it('进入不可撤销提交后暂停被明确拒绝，不写暂停意图也不重复提交', async () => {
  const f = await waitingReview()
  const versions = f.f.app.ports.versions
  const original = versions.commitCandidate.bind(versions)
  const reached = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  versions.commitCandidate = async (execution, candidate, requireVersion) => {
    reached.resolve()
    await released.promise
    return original(execution, candidate, requireVersion)
  }
  const baselineCount = f.f.git('rev-list', '--count', 'HEAD')
  await f.f.app.generation.replySceneGenerationInteraction(f.reply)
  const job = f.f.jobs.shift()
  if (!job) throw new Error('缺少接受任务')
  const running = job()
  await reached.promise

  await expect(f.f.app.control.pauseSceneGeneration(request)).rejects.toMatchObject({
    code: 4103
  })
  const committing = (await f.f.app.ports.executions.readExecution(request))!
  expect(committing.state).toBe('committing')
  expect(committing.pauseRequested).not.toBe(true)
  released.resolve()
  await running

  const finished = (await f.f.app.ports.executions.readExecution(request))!
  expect(finished.state).toBe('succeeded')
  expect(f.f.git('rev-parse', 'HEAD')).toBe(finished.result?.commitId)
  expect(f.f.git('rev-list', '--count', 'HEAD')).toBe(
    String(Number(baselineCount) + 1)
  )
  expect(await readPauseBoundary(join(f.f.root, 'state/ai'), finished)).toBeNull()
}, 30000)
