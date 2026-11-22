import { describe, expect, it, vi } from 'vitest'

import {
  createSceneGenerationFixture,
  generationRequest,
  waitForCancellation,
  waitForInteraction,
  waitingInteraction,
  questionInteraction
} from './sceneGenerationFixture'
import type { ReplySceneGenerationInteractionDTO } from '@application/scene-generation/dto/SceneGenerationDTO'
import type { WebGalGenerationStateValue } from '@infrastructure/scene-generation/workflow/WebGalGenerationState'
import type { SceneGenerationExecution } from '@application/scene-generation/models/SceneGenerationExecution'
import { SceneGenerationVersionConflict } from '@application/scene-generation/errors/SceneGenerationVersionConflict'
import type {
  SceneGenerationRenderProgressEventVO,
  SceneGenerationTimelineEntryVO
} from '@application/scene-generation/vo/SceneGenerationRenderVO'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { toRenderStatusVO } from '@application/scene-generation/mapping/SceneGenerationRenderProjection'
import { safeFailureWithDiagnosticRef } from '@application/scene-generation/services/impl/SceneGenerationFailureFacts'
import { RecoverCancelledSceneGeneration } from '@application/scene-generation/services/impl/RecoverCancelledSceneGeneration'

const replyRequest: ReplySceneGenerationInteractionDTO = {
  ...generationRequest,
  threadId: 'thread-1',
  branchId: 'branch-1',
  interactionId: 'interaction-1',
  checkpointId: 'checkpoint-1',
  candidateSnapshotId: 'snapshot-1',
  replyId: 'reply-1',
  reply: { kind: 'accept' }
}

describe('场景生成应用编排', () => {
  it('无指定分支的相同请求并发启动仍只创建一个线程和任务', async () => {
    const f = createSceneGenerationFixture()
    const results = await Promise.all([
      f.service.generateScene(generationRequest),
      f.service.generateScene(generationRequest)
    ])
    expect(results[0]).toEqual(results[1])
    expect(f.workflow.createExecution).toHaveBeenCalledTimes(1)
    expect(f.jobs).toHaveLength(1)
    expect(f.dispatches).toEqual([{ operationId: 'operation-1', projectId: 'project-1' }])
  })

  it('语义相同的请求不因字段顺序或默认审阅值被判为不同操作', async () => {
    const f = createSceneGenerationFixture()
    const first = await f.service.generateScene(generationRequest)
    await expect(
      f.service.generateScene({
        ...generationRequest,
        reviewCandidate: false,
        policy: { maxCorrections: 2 }
      })
    ).resolves.toEqual(first)
  })

  it('先返回操作身份，再读取真实候选、领域校验和原子提交，提交后才发布成功', async () => {
    const f = createSceneGenerationFixture()
    const started = await f.service.generateScene(generationRequest)
    expect(started).toMatchObject({
      operationId: 'operation-1',
      threadId: 'identity-1',
      branchId: 'identity-2'
    })
    expect(f.versions.commitCandidate).not.toHaveBeenCalled()
    await f.runNext()
    const status = await f.service.getSceneGenerationStatus(generationRequest)
    expect(status).toMatchObject({
      state: 'succeeded',
      result: { commitId: 'commit-operation-1', preview: { files: ['scenes/scene-1/start.txt'] } }
    })
    expect(f.workflow.executeGeneration.mock.calls[0][0].execution.reviewCandidate).toBe(false)
    expect(f.versions.commitCandidate.mock.calls[0][1].assetChanges).toEqual([
      'assets/new-background.webp'
    ])
    expect(f.artifacts.readCandidate).toHaveBeenCalledWith(expect.anything(), 'snapshot-1')
    expect(f.progress.at(-1)).toMatchObject({
      state: 'succeeded',
      phase: 'completed',
      message: '完成'
    })
    expect(f.artifacts.discardWorkspace).toHaveBeenCalledTimes(1)
    expect(f.progress.map((event) => event.sequence)).toEqual(
      [...f.progress.keys()].map((index) => index + 1)
    )
    expect(status.sequence).toBe(f.progress.at(-1)?.sequence)
  })

  it('输入保留素材路径与来源，快照不随提供方随后修改而改变', async () => {
    const f = createSceneGenerationFixture()
    const inputs = await f.input.readInputs(
      await f.input.locateScene(generationRequest),
      generationRequest.inputs
    )
    f.input.readInputs.mockResolvedValue(inputs)
    await f.service.generateScene(generationRequest)
    inputs.assets[0].relativePath = 'assets/changed.webp'
    await f.runNext()
    expect(
      f.workflow.executeGeneration.mock.calls[0][0].execution.inputSnapshot.assets[0]
    ).toMatchObject({ relativePath: 'assets/station.webp', sourceId: 'canvas-asset-1' })
  })

  it('重复启动返回同一操作，改变相同操作的输入明确拒绝', async () => {
    const f = createSceneGenerationFixture()
    const first = await f.service.generateScene(generationRequest)
    await expect(f.service.generateScene(generationRequest)).resolves.toEqual(first)
    expect(f.jobs).toHaveLength(1)
    await expect(
      f.service.generateScene({ ...generationRequest, reviewCandidate: true })
    ).rejects.toMatchObject({ code: 4103 })
    await expect(f.service.generateScene(generationRequest)).resolves.toEqual(first)
    expect(f.jobs).toHaveLength(1)
  })

  it('同线程的并发新操作只启动一个，生成任务不占据短串行段', async () => {
    const f = createSceneGenerationFixture()
    const branch = { threadId: 'thread-1', branchId: 'branch-1' }
    const results = await Promise.allSettled([
      f.service.generateScene({ ...generationRequest, branch }),
      f.service.generateScene({ ...generationRequest, operationId: 'operation-2', branch })
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(f.jobs).toHaveLength(1)
  })

  it('执行中的操作对状态查询可见，重启后同一持久记录只标记可恢复', async () => {
    const f = createSceneGenerationFixture()
    await f.service.generateScene(generationRequest)
    await expect(f.service.getSceneGenerationStatus(generationRequest)).resolves.toMatchObject({
      state: 'pending',
      canResume: false
    })
    await expect(f.restart().getSceneGenerationStatus(generationRequest)).resolves.toMatchObject({
      state: 'pending',
      canResume: true
    })
  })

  it('模型执行等待期间同一线程短操作仍可完成，取消不等待模型返回', async () => {
    const f = createSceneGenerationFixture()
    const modelGate = Promise.withResolvers<void>()
    const modelStarted = Promise.withResolvers<void>()
    f.workflow.executeGeneration.mockImplementation(async () => {
      modelStarted.resolve()
      await modelGate.promise
      return f.ready
    })
    await f.service.generateScene(generationRequest)
    const running = f.runNext()
    await modelStarted.promise
    await expect(f.service.getSceneGenerationStatus(generationRequest)).resolves.toMatchObject({
      state: 'running',
      canResume: false
    })
    await expect(f.service.cancelSceneGeneration(generationRequest)).resolves.toMatchObject({
      state: 'cancelling'
    })
    expect(f.executions.get('operation-1')?.state).toBe('cancelling')
    expect(f.workflow.executeGeneration.mock.calls[0][0].signal.aborted).toBe(true)
    modelGate.resolve()
    await running
    await expect(f.service.getSceneGenerationStatus(generationRequest)).resolves.toMatchObject({
      state: 'cancelled'
    })
    expect(f.versions.commitCandidate).not.toHaveBeenCalled()
  })

  it('等待进度写入后立即回答：旧运行收尾不覆盖新回复', async () => {
    const f = createSceneGenerationFixture()
    const published = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    f.workflow.executeGeneration.mockImplementationOnce(async (runtime) => {
      await runtime.publishProgress({
        state: 'waiting',
        step: undefined,
        interaction: waitingInteraction,
        checkpointId: 'checkpoint-1',
        candidateSnapshotId: 'snapshot-1',
        attempt: runtime.execution.attempt,
        budget: runtime.execution.budget
      })
      published.resolve()
      await release.promise
      return {
        state: 'waiting',
        interaction: waitingInteraction,
        checkpointId: 'checkpoint-1',
        candidateSnapshotId: 'snapshot-1',
        budget: runtime.execution.budget
      }
    })
    const started = await f.service.generateScene(generationRequest)
    const oldRun = f.runNext()
    await published.promise
    await f.service.replySceneGenerationInteraction({
      ...replyRequest,
      threadId: started.threadId,
      branchId: started.branchId
    })
    expect(f.executions.get('operation-1')).toMatchObject({
      state: 'pending',
      pendingReply: { replyId: 'reply-1' }
    })

    release.resolve()
    await oldRun
    expect(f.executions.get('operation-1')).toMatchObject({
      state: 'pending',
      pendingReply: { replyId: 'reply-1' }
    })
    expect(f.versions.commitCandidate).not.toHaveBeenCalled()

    await f.runNext()
    await expect(f.service.getSceneGenerationStatus(generationRequest)).resolves.toMatchObject({
      state: 'succeeded'
    })
    expect(f.versions.commitCandidate).toHaveBeenCalledTimes(1)
    expect(f.executions.get('operation-1')?.replies.map((reply) => reply.replyId)).toEqual([
      'reply-1'
    ])
  })

  it('取消受理后迟到的等待进度被持久边界拒绝，本次运行按取消收尾', async () => {
    const f = createSceneGenerationFixture()
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    f.workflow.executeGeneration.mockImplementationOnce(async (runtime) => {
      started.resolve()
      await release.promise
      await runtime.publishProgress({
        state: 'waiting',
        step: undefined,
        interaction: waitingInteraction,
        checkpointId: 'checkpoint-1',
        candidateSnapshotId: 'snapshot-1',
        attempt: runtime.execution.attempt,
        budget: runtime.execution.budget
      })
      return {
        state: 'waiting',
        interaction: waitingInteraction,
        checkpointId: 'checkpoint-1',
        candidateSnapshotId: 'snapshot-1',
        budget: runtime.execution.budget
      }
    })
    const operation = await f.service.generateScene(generationRequest)
    const running = f.runNext()
    await started.promise
    await expect(f.service.cancelSceneGeneration(generationRequest)).resolves.toMatchObject({
      state: 'cancelling'
    })
    expect(f.executions.get('operation-1')).toMatchObject({
      state: 'cancelling',
      cancellationRequested: true
    })
    await expect(
      f.service.replySceneGenerationInteraction({
        ...replyRequest,
        threadId: operation.threadId,
        branchId: operation.branchId
      })
    ).rejects.toMatchObject({
      code: 4103
    })
    const writesBefore = f.workflow.writeExecution.mock.calls.length

    release.resolve()
    await running
    const lateWrites = f.workflow.writeExecution.mock.calls
      .slice(writesBefore)
      .map(([execution]) => execution)
    expect(lateWrites.some((execution) => execution.state === 'waiting')).toBe(false)
    expect(f.executions.get('operation-1')).toMatchObject({
      state: 'cancelled',
      cancellationRequested: true,
      interaction: undefined,
      pendingReply: undefined
    })
    expect(f.artifacts.discardWorkspace).toHaveBeenCalledTimes(1)
    expect(f.versions.commitCandidate).not.toHaveBeenCalled()
  })

  it('领域请求拒绝不完整来源时不创建工作区或操作', async () => {
    const f = createSceneGenerationFixture()
    f.input.readInputs.mockResolvedValue({
      canvasId: 'canvas-1',
      arrangementVersion: 'arrangement-1',
      assets: [],
      documents: [],
      prompts: [
        {
          id: 'prompt-1',
          title: '剧情',
          body: ' ',
          scopes: [{ kind: 'scene' }],
          references: [],
          usage: { targetIds: [] }
        }
      ],
      fieldBindings: [],
      relations: [],
      confirmedControls: []
    })
    await expect(f.service.generateScene(generationRequest)).rejects.toMatchObject({ code: 4212 })
    expect(f.workflow.createExecution).not.toHaveBeenCalled()
    expect(f.artifacts.createWorkspace).not.toHaveBeenCalled()
  })

  it('等待人工保留持久问题与线程逻辑位置，重启查询只读且不续跑', async () => {
    const f = createSceneGenerationFixture()
    waitForInteraction(f)
    const started = await f.service.generateScene(generationRequest)
    await f.runNext()
    const restarted = f.restart()
    const writes = f.workflow.writeExecution.mock.calls.length
    await expect(restarted.getSceneGenerationStatus(generationRequest)).resolves.toMatchObject({
      state: 'waiting',
      interaction: waitingInteraction,
      canResume: false
    })
    expect(f.workflow.writeExecution).toHaveBeenCalledTimes(writes)
    await expect(
      restarted.generateScene({ ...generationRequest, operationId: 'operation-2', branch: started })
    ).rejects.toMatchObject({ code: 4103 })
    expect(f.artifacts.discardWorkspace).not.toHaveBeenCalled()
  })

  it('人工修改候选真实文件后失效旧校验与转换结果并保存新快照', async () => {
    const f = createSceneGenerationFixture()
    waitForInteraction(f)
    await f.service.generateScene(generationRequest)
    await f.runNext()

    const edited = await f.service.editSceneGenerationCandidate({
      ...generationRequest,
      candidateSnapshotId: 'snapshot-1',
      files: [{ relativePath: 'scenes/scene-1/start.txt', content: '旁白:人工修改\n' }]
    })

    expect(f.artifacts.writeCandidateFiles).toHaveBeenCalledWith(
      expect.objectContaining({ candidateSnapshotId: 'snapshot-1' }),
      expect.objectContaining({
        files: [{ relativePath: 'scenes/scene-1/start.txt', content: '旁白:人工修改\n' }]
      })
    )
    expect(edited).toMatchObject({ state: 'interrupted', phase: 'reading' })
    expect(f.executions.get('operation-1')).toMatchObject({
      candidateSnapshotId: 'snapshot-2',
      checkpointId: undefined,
      preview: undefined
    })
  })

  it('重复人工回复返回同一接受凭证，先持久回复再继续，同标识不同内容拒绝', async () => {
    const f = createSceneGenerationFixture()
    waitForInteraction(f)
    const started = await f.service.generateScene(generationRequest)
    const reply = { ...replyRequest, threadId: started.threadId, branchId: started.branchId }
    await f.runNext()
    const first = await f.service.replySceneGenerationInteraction(reply)
    await expect(f.service.replySceneGenerationInteraction(reply)).resolves.toEqual(first)
    expect(f.executions.get('operation-1')?.pendingReply).toEqual(reply)
    expect(f.jobs).toHaveLength(1)
    await expect(
      f.service.replySceneGenerationInteraction({
        ...reply,
        reply: { kind: 'revise', body: '修改结尾' }
      })
    ).rejects.toMatchObject({ code: 4103 })
    await f.runNext()
    expect(f.workflow.continueInteraction).toHaveBeenCalledTimes(1)
    expect(f.artifacts.readCandidate).toHaveBeenCalledTimes(1)
  })

  it('接受回复后继续运行时清空上一轮审阅交互，进度不再携带旧入口', async () => {
    const f = createSceneGenerationFixture()
    waitForInteraction(f)
    const started = await f.service.generateScene(generationRequest)
    const reply = { ...replyRequest, threadId: started.threadId, branchId: started.branchId }
    await f.runNext()
    expect(f.executions.get('operation-1')).toMatchObject({
      state: 'waiting',
      interaction: waitingInteraction
    })

    await f.service.replySceneGenerationInteraction(reply)
    await f.runNext()

    expect(f.executions.get('operation-1')?.interaction).toBeUndefined()
    const running = f.progress.filter((event) => event.state === 'running')
    expect(running.length).toBeGreaterThan(0)
    expect(running.every((event) => event.interaction === undefined)).toBe(true)
  })

  it('过期待回复、非法选项和不允许的回复不写入，不启动继续', async () => {
    const f = createSceneGenerationFixture()
    waitForInteraction(f)
    const started = await f.service.generateScene(generationRequest)
    const reply = { ...replyRequest, threadId: started.threadId, branchId: started.branchId }
    await f.runNext()
    await expect(
      f.service.replySceneGenerationInteraction({ ...reply, interactionId: 'expired' })
    ).rejects.toMatchObject({ code: 4103 })
    await expect(
      f.service.replySceneGenerationInteraction({
        ...reply,
        reply: { kind: 'select', optionId: 'unknown' }
      })
    ).rejects.toMatchObject({ code: 4101 })
    expect(f.executions.get('operation-1')?.replies).toEqual([])
    expect(f.jobs).toHaveLength(0)
  })

  it('问题组只持久化一次并只继续一次，同标识不同答案拒绝', async () => {
    const f = createSceneGenerationFixture()
    f.workflow.executeGeneration.mockResolvedValueOnce({
      checkpointId: f.ready.checkpointId,
      budget: f.ready.budget,
      state: 'waiting',
      interaction: questionInteraction
    })
    const started = await f.service.generateScene(generationRequest)
    await f.runNext()
    const reply = {
      ...replyRequest,
      threadId: started.threadId,
      branchId: started.branchId,
      reply: {
        kind: 'answers' as const,
        answers: [
          { questionId: 'q2', optionId: 'q2o1', body: ' 后答 ' },
          { questionId: 'q1', optionId: 'q1o2' }
        ]
      }
    }
    const first = await f.service.replySceneGenerationInteraction(reply)
    const stored = f.executions.get('operation-1')?.pendingReply
    expect(stored?.selections?.map((item) => item.questionId)).toEqual(['q1', 'q2'])
    expect(stored?.selections?.[0]).toMatchObject({ prompt: '问题 1', label: '选项 2' })
    expect(stored?.reply).not.toHaveProperty('prompt')
    await expect(
      f.service.replySceneGenerationInteraction({
        ...reply,
        reply: {
          kind: 'answers',
          answers: [
            { questionId: 'q1', optionId: 'q1o2' },
            { questionId: 'q2', optionId: 'q2o3' }
          ]
        }
      })
    ).rejects.toMatchObject({ code: 4103 })
    await expect(f.service.replySceneGenerationInteraction(reply)).resolves.toEqual(first)
    expect(f.jobs).toHaveLength(1)
    await f.runNext()
    expect(f.workflow.continueInteraction).toHaveBeenCalledTimes(1)
  })
  it('回复前重新核对作品基线，人工接受不能覆盖等待期间的人工修改', async () => {
    const f = createSceneGenerationFixture()
    waitForInteraction(f)
    const started = await f.service.generateScene(generationRequest)
    await f.runNext()
    f.versions.inspectBaseline.mockResolvedValue({
      baselineState: 'changed',
      lockState: 'unlocked'
    })
    await expect(
      f.service.replySceneGenerationInteraction({
        ...replyRequest,
        threadId: started.threadId,
        branchId: started.branchId
      })
    ).rejects.toMatchObject({
      code: 4103
    })
    expect(f.jobs).toHaveLength(0)
    expect(f.artifacts.discardWorkspace).not.toHaveBeenCalled()
  })

  it('取消实际中止工作流，结束后清理候选并保留取消终态', async () => {
    const f = createSceneGenerationFixture()
    f.workflow.executeGeneration.mockImplementation(waitForCancellation)
    await f.service.generateScene(generationRequest)
    const running = f.runNext()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await f.service.cancelSceneGeneration(generationRequest)
    await running
    await expect(f.service.getSceneGenerationStatus(generationRequest)).resolves.toMatchObject({
      state: 'cancelled'
    })
    expect(f.workflow.executeGeneration.mock.calls[0][0].signal.aborted).toBe(true)
    expect(f.artifacts.discardWorkspace).toHaveBeenCalledTimes(1)
    expect(f.versions.commitCandidate).not.toHaveBeenCalled()
  })

  it('运行中重复取消只受理一次，不重复推进序号也不等待模型', async () => {
    const f = createSceneGenerationFixture()
    f.workflow.executeGeneration.mockImplementation(waitForCancellation)
    await f.service.generateScene(generationRequest)
    await expect(f.service.cancelSceneGeneration(generationRequest)).resolves.toMatchObject({
      state: 'cancelling'
    })
    const first = f.executions.get('operation-1')!
    expect(first.cancellationRequested).toBe(true)
    expect(first.interaction).toBeUndefined()
    expect(first.pendingReply).toBeUndefined()
    await expect(f.service.cancelSceneGeneration(generationRequest)).resolves.toMatchObject({
      state: 'cancelling'
    })
    expect(f.executions.get('operation-1')?.sequence).toBe(first.sequence)
    await f.runNext()
    await expect(f.service.getSceneGenerationStatus(generationRequest)).resolves.toMatchObject({
      state: 'cancelled'
    })
  })

  it('取消等待操作无需运行工作流，已提交作品拒绝取消且不改写', async () => {
    const waiting = createSceneGenerationFixture()
    waitForInteraction(waiting)
    await waiting.service.generateScene(generationRequest)
    await waiting.runNext()
    const waitingBefore = waiting.executions.get('operation-1')!
    await expect(waiting.service.cancelSceneGeneration(generationRequest)).resolves.toMatchObject({
      state: 'cancelled'
    })
    expect(waiting.executions.get('operation-1')).toMatchObject({
      state: 'cancelled',
      sequence: waitingBefore.sequence + 1,
      interaction: undefined,
      pendingReply: undefined,
      requiresCleanup: false
    })
    expect(waiting.artifacts.discardWorkspace).toHaveBeenCalledTimes(1)
    const committed = createSceneGenerationFixture()
    await committed.service.generateScene(generationRequest)
    await committed.runNext()
    const writesBefore = committed.workflow.writeExecution.mock.calls.length
    const committedBefore = committed.executions.get('operation-1')!
    await expect(committed.service.cancelSceneGeneration(generationRequest)).rejects.toMatchObject({
      code: 4103,
      message: '作品已提交，不能取消'
    })
    expect(committed.executions.get('operation-1')).toEqual(committedBefore)
    expect(committed.workflow.writeExecution).toHaveBeenCalledTimes(writesBefore)
    expect(committed.versions.rollbackCandidate).not.toHaveBeenCalled()
  })

  it('提交门已写入 committing 后取消被拒绝，提交只发生一次', async () => {
    const f = createSceneGenerationFixture()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    f.versions.commitCandidate.mockImplementation(
      async (execution: SceneGenerationExecution) => {
        entered.resolve()
        await release.promise
        return { commitId: 'commit-' + execution.operationId }
      }
    )
    await f.service.generateScene(generationRequest)
    const running = f.runNext()
    await entered.promise
    expect(f.executions.get('operation-1')?.state).toBe('committing')
    const writesBefore = f.workflow.writeExecution.mock.calls.length
    await expect(f.control().cancelSceneGeneration(generationRequest)).rejects.toMatchObject({
      code: 4103,
      message: '正在提交作品，不能取消'
    })
    expect(f.executions.get('operation-1')?.state).toBe('committing')
    expect(f.executions.get('operation-1')?.cancellationRequested).toBeUndefined()
    expect(f.workflow.writeExecution).toHaveBeenCalledTimes(writesBefore)
    release.resolve()
    await running
    await expect(f.service.getSceneGenerationStatus(generationRequest)).resolves.toMatchObject({
      state: 'succeeded'
    })
    expect(f.versions.commitCandidate).toHaveBeenCalledTimes(1)
  })

  it('无活动取消清理失败保留原失败并可重试，成功后重复取消不推进序号', async () => {
    const f = createSceneGenerationFixture()
    await f.service.generateScene(generationRequest)
    const originalFailure = safeFailureWithDiagnosticRef(
      new AppException({ code: 500, msg: '提交失败' })
    )
    const recorded = f.executions.get('operation-1')!
    f.executions.set('operation-1', {
      ...recorded,
      state: 'cancelling',
      cancellationRequested: true,
      requiresCleanup: true,
      failure: originalFailure,
      sequence: recorded.sequence + 1,
      step: undefined,
      interaction: undefined,
      pendingReply: undefined
    })
    const restarted = f.restart()
    f.artifacts.discardWorkspace.mockRejectedValueOnce(new Error('cleanup unavailable'))
    await expect(restarted.cancelSceneGeneration(generationRequest)).rejects.toMatchObject({
      code: ErrorCodes.internalError,
      message: '取消尚未完成清理，请重试结束本次生成并核对作品状态'
    })
    const interrupted = f.executions.get('operation-1')!
    expect(interrupted).toMatchObject({
      state: 'interrupted',
      requiresCleanup: true,
      cancellationRequested: true
    })
    expect(interrupted.failure).toEqual(originalFailure)
    const render = toRenderStatusVO(interrupted, false, { resume: true, pause: true })
    expect(render.canResume).toBe(false)
    expect(render.stageMessage).toBe('取消尚未完成清理，请重新结束本次生成')
    expect(render.canCancel).toBe(true)
    await expect(restarted.cancelSceneGeneration(generationRequest)).resolves.toMatchObject({
      state: 'cancelled'
    })
    const cancelled = f.executions.get('operation-1')!
    expect(cancelled).toMatchObject({
      state: 'cancelled',
      cancellationRequested: true,
      requiresCleanup: false
    })
    const sequence = cancelled.sequence
    const discardCalls = f.artifacts.discardWorkspace.mock.calls.length
    await expect(restarted.cancelSceneGeneration(generationRequest)).resolves.toMatchObject({
      state: 'cancelled'
    })
    expect(f.executions.get('operation-1')?.sequence).toBe(sequence)
    expect(f.artifacts.discardWorkspace).toHaveBeenCalledTimes(discardCalls)
  })

  it('工程级取消清理只处理已受理且需要收尾的记录', async () => {
    const f = createSceneGenerationFixture()
    await f.service.generateScene(generationRequest)
    const template = f.executions.get('operation-1')!
    f.restart()
    const seed = (
      operationId: string,
      patch: Partial<SceneGenerationExecution>
    ): SceneGenerationExecution => ({
      ...structuredClone(template),
      operationId,
      threadId: `thread-${operationId}`,
      branchId: `branch-${operationId}`,
      ...patch
    })
    const records = [
      seed('done', { state: 'cancelled', cancellationRequested: true }),
      seed('failed', { state: 'failed' }),
      seed('write-unknown', {
        state: 'interrupted',
        interruptReason: 'writeUnknown',
        requiresCleanup: false,
        cancellationRequested: true
      }),
      seed('waiting', {
        state: 'waiting',
        requiresCleanup: true,
        cancellationRequested: true
      }),
      seed('cleanup', {
        state: 'interrupted',
        requiresCleanup: true,
        cancellationRequested: true
      })
    ]
    f.executions.clear()
    for (const record of records) f.executions.set(record.operationId, record)

    const recovery = new RecoverCancelledSceneGeneration({
      deps: f.deps,
      coordinator: f.coordinator
    })
    await expect(recovery.recoverCancelledProject('project-1')).resolves.toEqual({
      attempted: 1,
      failed: 0
    })
    expect(f.executions.get('cleanup')).toMatchObject({
      state: 'cancelled',
      cancellationRequested: true,
      requiresCleanup: false
    })
    expect(f.executions.get('done')).toEqual(records[0])
    expect(f.executions.get('failed')).toEqual(records[1])
    expect(f.executions.get('write-unknown')).toEqual(records[2])
    expect(f.executions.get('waiting')).toEqual(records[3])
    expect(f.artifacts.discardWorkspace).toHaveBeenCalledTimes(1)
    expect(f.workflow.executeGeneration).not.toHaveBeenCalled()
  })

  it('最终读取仍有业务问题时拒绝提交并清理，不信任工作流声称的通过', async () => {
    const f = createSceneGenerationFixture()
    f.artifacts.readCandidate.mockResolvedValue({
      ...f.candidate,
      artifact: { ...f.candidate.artifact, hasEntry: false }
    })
    await f.service.generateScene(generationRequest)
    await expect(f.runNext()).rejects.toMatchObject({ code: 4103 })
    expect(f.versions.commitCandidate).not.toHaveBeenCalled()
    expect(f.artifacts.discardWorkspace).toHaveBeenCalledTimes(1)
    expect(f.progress.at(-1)?.state).toBe('failed')
  })

  it('提交边界再次检查锁定与基线，边界内发生冲突不会覆盖正式文件', async () => {
    const f = createSceneGenerationFixture()
    f.versions.commitCandidate.mockImplementation(async (execution, candidate, requireVersion) => {
      requireVersion({ baselineState: 'changed', lockState: 'unlocked' })
      throw new Error('不应继续提交')
    })
    await f.service.generateScene(generationRequest)
    await expect(f.runNext()).rejects.toMatchObject({ code: 4103 })
    expect(f.commits.size).toBe(0)
    expect(f.progress.some((event) => event.state === 'succeeded')).toBe(false)
  })

  it.each([
    { baselineState: 'changed', lockState: 'unlocked', message: '目标场景基线已变化，不能覆盖' },
    { baselineState: 'unknown', lockState: 'unlocked', message: '目标场景基线不明，不能覆盖' },
    { baselineState: 'unchanged', lockState: 'locked', message: '目标场景已锁定，不能覆盖' },
    { baselineState: 'unchanged', lockState: 'unknown', message: '目标场景锁定状态不明，不能覆盖' }
  ] as const)(
    '提交前事实 $baselineState/$lockState 分类为版本冲突并保留候选',
    async (facts) => {
      const f = createSceneGenerationFixture()
      f.versions.inspectBaseline.mockResolvedValue(facts)
      await f.service.generateScene(generationRequest)

      const failed = await f.runNext().then(
        () => undefined,
        (error: unknown) => error
      )
      expect(failed).toBeInstanceOf(SceneGenerationVersionConflict)
      expect(failed).toMatchObject({ code: 4103, message: facts.message })
      expect(f.versions.commitCandidate).not.toHaveBeenCalled()
      expect(f.versions.rollbackCandidate).not.toHaveBeenCalled()
      expect(f.artifacts.discardWorkspace).not.toHaveBeenCalled()
      expect(f.executions.get('operation-1')).toMatchObject({
        state: 'interrupted',
        interruptReason: 'candidateConflict',
        requiresCleanup: false
      })
      expect(f.commits.size).toBe(0)
    }
  )

  it('非覆盖类候选问题按普通业务冲突拒绝，不误分类为版本冲突', async () => {
    const f = createSceneGenerationFixture()
    f.artifacts.readCandidate.mockResolvedValue({
      ...f.candidate,
      artifact: {
        ...f.candidate.artifact,
        scene: { projectId: 'project-1', sceneId: 'other-scene' }
      }
    })
    await f.service.generateScene(generationRequest)

    const failed = await f.runNext().then(
      () => undefined,
      (error: unknown) => error
    )
    expect(failed).toBeInstanceOf(AppException)
    expect(failed).not.toBeInstanceOf(SceneGenerationVersionConflict)
    expect(failed).toMatchObject({
      code: 4103,
      message: '候选场景与生成目标不是同一个场景'
    })
    expect(f.versions.commitCandidate).not.toHaveBeenCalled()
    expect(f.artifacts.discardWorkspace).toHaveBeenCalledTimes(1)
    expect(f.executions.get('operation-1')).toMatchObject({ state: 'failed' })
  })

  it('提交按读取候选、校验、提交边界复验、清理和终态写入顺序推进', async () => {
    const f = createSceneGenerationFixture()
    const order: string[] = []
    f.artifacts.readCandidate.mockImplementation(async () => {
      order.push('readCandidate')
      expect(f.executions.get('operation-1')).toMatchObject({
        state: 'running',
        step: 'reading'
      })
      return f.candidate
    })
    f.versions.inspectBaseline.mockImplementation(async () => {
      order.push('inspectBaseline')
      expect(f.executions.get('operation-1')).toMatchObject({
        state: 'running',
        step: 'validating'
      })
      return { baselineState: 'unchanged', lockState: 'unlocked' }
    })
    f.versions.commitCandidate.mockImplementation(async (execution, candidate, requireVersion) => {
      order.push('commitCandidate')
      expect(f.executions.get('operation-1')).toMatchObject({
        state: 'committing',
        step: 'committing',
        preview: expect.objectContaining({ validationReport: { issues: [] } })
      })
      requireVersion({ baselineState: 'unchanged', lockState: 'unlocked' })
      order.push('requireVersion')
      return { commitId: 'commit-operation-1' }
    })
    f.artifacts.discardWorkspace.mockImplementation(async () => {
      order.push('discardWorkspace')
      expect(f.executions.get('operation-1')).toMatchObject({ state: 'committing' })
    })
    await f.service.generateScene(generationRequest)
    await f.runNext()

    expect(order).toEqual([
      'readCandidate',
      'inspectBaseline',
      'commitCandidate',
      'requireVersion',
      'discardWorkspace'
    ])
    expect(f.versions.commitCandidate).toHaveBeenCalledTimes(1)
    expect(f.executions.get('operation-1')).toMatchObject({
      state: 'succeeded',
      step: undefined,
      result: { commitId: 'commit-operation-1' },
      workspace: undefined
    })
  })

  it('提交响应丢失时先查询已提交事实，确认成功后不重提或回退', async () => {
    const f = createSceneGenerationFixture()
    f.versions.commitCandidate.mockImplementation(async (execution) => {
      f.commits.set(execution.operationId, { state: 'committed', commitId: 'confirmed-commit' })
      throw new Error('提交响应丢失')
    })
    await f.service.generateScene(generationRequest)
    await f.runNext()
    expect(f.executions.get('operation-1')?.result?.commitId).toBe('confirmed-commit')
    expect(f.versions.commitCandidate).toHaveBeenCalledTimes(1)
    expect(f.versions.rollbackCandidate).not.toHaveBeenCalled()
  })

  it('提交结果不明时保留候选与可恢复记录，不盲目清理或重提', async () => {
    const f = createSceneGenerationFixture()
    f.versions.commitCandidate.mockRejectedValue(new Error('提交失败'))
    f.versions.readOperationCommit.mockResolvedValue({ state: 'unknown' })
    await f.service.generateScene(generationRequest)
    await expect(f.runNext()).rejects.toThrow()
    expect(f.executions.get('operation-1')?.state).toBe('interrupted')
    expect(f.artifacts.discardWorkspace).not.toHaveBeenCalled()
    expect(f.versions.rollbackCandidate).not.toHaveBeenCalled()
  })

  it('需要回退时只回退本操作，原始失败和回退失败都保留', async () => {
    const f = createSceneGenerationFixture()
    const original = new Error('原始提交失败')
    const rollback = new Error('回退失败')
    f.versions.commitCandidate.mockRejectedValue(original)
    f.versions.readOperationCommit.mockResolvedValue({
      state: 'rollbackRequired',
      commitId: 'partial-commit'
    })
    f.versions.rollbackCandidate.mockRejectedValue(rollback)
    await f.service.generateScene(generationRequest)
    await expect(f.runNext()).rejects.toMatchObject({ cause: { errors: [original, rollback] } })
    expect(f.versions.rollbackCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: 'operation-1' }),
      'partial-commit'
    )
    expect(f.executions.get('operation-1')?.state).toBe('interrupted')
    expect(f.artifacts.discardWorkspace).not.toHaveBeenCalled()
  })

  it('失败与候选清理同时失败时保留两个原因，状态可恢复且不发布成功', async () => {
    const f = createSceneGenerationFixture()
    const original = new Error('模型失败')
    const cleanup = new Error('清理失败')
    f.workflow.executeGeneration.mockRejectedValue(original)
    f.artifacts.discardWorkspace.mockRejectedValue(cleanup)
    await f.service.generateScene(generationRequest)
    await expect(f.runNext()).rejects.toMatchObject({ cause: { errors: [original, cleanup] } })
    expect(f.executions.get('operation-1')?.state).toBe('interrupted')
    expect(f.progress.some((event) => event.state === 'succeeded')).toBe(false)
  })

  it('核对提交事实失败时保留中断记录和清理要求，不丢弃候选', async () => {
    const f = createSceneGenerationFixture()
    f.workflow.executeGeneration.mockRejectedValue(new Error('原始失败'))
    f.versions.readOperationCommit.mockRejectedValue(new Error('提交事实读取失败'))
    await f.service.generateScene(generationRequest)
    await expect(f.runNext()).rejects.toMatchObject({ code: 5103 })
    expect(f.executions.get('operation-1')).toMatchObject({
      state: 'interrupted',
      requiresCleanup: true,
      failure: { code: 5103 }
    })
    expect(f.artifacts.discardWorkspace).not.toHaveBeenCalled()
    expect(f.versions.commitCandidate).not.toHaveBeenCalled()
    expect(f.versions.rollbackCandidate).not.toHaveBeenCalled()
  })

  it('恢复失败清理只重试清理，保留原始失败而不再调用模型', async () => {
    const f = createSceneGenerationFixture()
    f.workflow.executeGeneration.mockRejectedValue(new Error('原始模型失败'))
    f.artifacts.discardWorkspace.mockRejectedValueOnce(new Error('第一次清理失败'))
    await f.service.generateScene(generationRequest)
    await expect(f.runNext()).rejects.toThrow()
    await expect(f.restart().resumeSceneGeneration(generationRequest)).resolves.toMatchObject({
      state: 'failed',
      failure: { code: 5103 }
    })
    expect(f.jobs).toHaveLength(0)
    expect(f.workflow.resumeGeneration).not.toHaveBeenCalled()
  })

  it('取消后清理失败的恢复仍结束为取消，不恢复模型生成', async () => {
    const f = createSceneGenerationFixture()
    waitForInteraction(f)
    await f.service.generateScene(generationRequest)
    await f.runNext()
    f.artifacts.discardWorkspace.mockRejectedValueOnce(new Error('清理失败'))
    await expect(f.service.cancelSceneGeneration(generationRequest)).rejects.toThrow()
    await expect(f.restart().resumeSceneGeneration(generationRequest)).resolves.toMatchObject({
      state: 'cancelled'
    })
    expect(f.jobs).toHaveLength(0)
  })

  it('恢复时重查已登记工程位置，再核对当前基线，不沿用旧工程目录', async () => {
    const f = createSceneGenerationFixture()
    f.workflow.executeGeneration.mockResolvedValueOnce({ ...f.ready, state: 'interrupted' })
    await f.service.generateScene(generationRequest)
    await f.runNext()
    f.input.locateScene.mockResolvedValue({
      projectId: 'project-1',
      sceneId: 'scene-1',
      projectRoot: '/moved-project',
      sceneDirectory: 'scenes/scene-1',
      entryFile: 'start.txt'
    })
    f.restart()
    const paused = f.executions.get('operation-1')!
    // 普通恢复不能绕过暂停授权；显式继续必须携带当前检查点与候选身份。
    await f.control().resumeSceneGeneration({
      projectId: paused.projectId,
      sceneId: paused.sceneId,
      operationId: paused.operationId,
      threadId: paused.threadId,
      branchId: paused.branchId,
      checkpointId: paused.checkpointId!,
      candidateSnapshotId: paused.candidateSnapshotId
    })
    await f.runNext()
    expect(f.versions.inspectBaseline).toHaveBeenLastCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({ projectRoot: '/moved-project' })
      })
    )
  })

  it('检查点快照缺失时状态明确不可恢复，恢复拒绝且不借用当前文件', async () => {
    const f = createSceneGenerationFixture()
    f.workflow.executeGeneration.mockResolvedValueOnce({ ...f.ready, state: 'interrupted' })
    const started = await f.service.generateScene(generationRequest)
    await f.runNext()
    const execution = f.executions.get('operation-1')!
    f.workflow.readCheckpoint.mockResolvedValue({
      execution,
      view: {
        ...started,
        checkpointId: 'checkpoint-1',
        phase: 'generating',
        summary: '旧记录',
        decisions: [],
        differences: [],
        canView: true,
        canContinue: false,
        canFork: false,
        reason: '候选快照缺失'
      }
    })
    const restarted = f.restart()
    await expect(restarted.getSceneGenerationStatus(generationRequest)).resolves.toMatchObject({
      canResume: false,
      resumeReason: '候选快照缺失'
    })
    await expect(restarted.resumeSceneGeneration(generationRequest)).rejects.toMatchObject({
      code: 4103
    })
    expect(f.artifacts.restoreWorkspace).not.toHaveBeenCalled()
    expect(f.jobs).toHaveLength(0)
  })

  it('工作区创建失败也进入事务清理，留下明确失败状态', async () => {
    const f = createSceneGenerationFixture()
    f.artifacts.createWorkspace.mockRejectedValue(new Error('创建中断'))
    await f.service.generateScene(generationRequest)
    await expect(f.runNext()).rejects.toThrow('创建中断')
    expect(f.artifacts.discardWorkspace).toHaveBeenCalledTimes(1)
    expect(f.executions.get('operation-1')?.state).toBe('failed')
  })

  it('进程重启先查询本操作提交，提交后退出不会重复执行模型或 Git', async () => {
    const f = createSceneGenerationFixture()
    await f.service.generateScene(generationRequest)
    const execution = f.executions.get('operation-1')!
    f.executions.set('operation-1', {
      ...execution,
      state: 'committing',
      preview: f.candidate.preview,
      checkpointId: 'checkpoint-1',
      candidateSnapshotId: 'snapshot-1'
    })
    f.commits.set('operation-1', { state: 'committed', commitId: 'previous-commit' })
    await expect(f.restart().resumeSceneGeneration(generationRequest)).resolves.toMatchObject({
      state: 'succeeded',
      result: { commitId: 'previous-commit' }
    })
    expect(f.workflow.resumeGeneration).not.toHaveBeenCalled()
    expect(f.versions.commitCandidate).not.toHaveBeenCalled()
  })

  it('重复恢复只派发一次，恢复原候选与原预算，等待时间不消耗预算', async () => {
    const f = createSceneGenerationFixture()
    f.workflow.executeGeneration.mockResolvedValueOnce({
      ...f.ready,
      state: 'interrupted',
      budget: { ...f.ready.budget, correctionsUsed: 1, modelCallsUsed: 4 }
    })
    await f.service.generateScene(generationRequest)
    f.advanceTime(250)
    await f.runNext()
    const saved = f.executions.get('operation-1')!
    f.advanceTime(1000000)
    f.restart()
    const control = f.control()
    const identity = {
      projectId: saved.projectId,
      sceneId: saved.sceneId,
      operationId: saved.operationId,
      threadId: saved.threadId,
      branchId: saved.branchId,
      checkpointId: saved.checkpointId!,
      candidateSnapshotId: saved.candidateSnapshotId
    }
    await Promise.all([
      control.resumeSceneGeneration(identity),
      control.resumeSceneGeneration(identity)
    ])
    expect(f.jobs).toHaveLength(1)
    await f.runNext()
    expect(f.artifacts.restoreWorkspace).toHaveBeenCalledWith(expect.anything(), 'snapshot-1')
    expect(f.workflow.resumeGeneration.mock.calls[0][0].execution.budget).toEqual(saved.budget)
  })

  it('工作流进度持久保存活跃时长，中断后不会重置已消耗的时间', async () => {
    const f = createSceneGenerationFixture()
    f.workflow.executeGeneration.mockImplementation(async (runtime) => {
      f.advanceTime(125)
      await runtime.publishProgress({ step: 'generating', attempt: 1, budget: f.ready.budget })
      expect(f.executions.get('operation-1')?.budget.activeElapsedMs).toBe(125)
      return { ...f.ready, state: 'interrupted' }
    })
    await f.service.generateScene(generationRequest)
    await f.runNext()
    expect(f.executions.get('operation-1')?.budget.activeElapsedMs).toBe(125)
  })

  it('失败进度返回持久执行事实，关联检查点时沿用首次结算预算且入口快照不变', async () => {
    const f = createSceneGenerationFixture()
    const failure = new Error('工作流停止')
    f.workflow.executeGeneration.mockImplementation(async (runtime) => {
      const initial = structuredClone(runtime.execution)
      f.advanceTime(125)
      const settled = await runtime.publishProgress({
        step: undefined,
        attempt: 1,
        budget: { ...f.ready.budget, modelCallsUsed: 3, activeElapsedMs: 125 },
        checkpointId: 'failure-checkpoint'
      })
      expect(settled.step).toBeUndefined()
      expect(settled).toMatchObject({
        checkpointId: 'failure-checkpoint',
        budget: { activeElapsedMs: 125, modelCallsUsed: 3 }
      })
      expect(settled).toEqual(f.executions.get('operation-1'))
      f.advanceTime(75)
      const associated = await runtime.publishProgress({
        step: undefined,
        attempt: 1,
        budget: settled.budget,
        checkpointId: 'associated-checkpoint'
      })
      expect(associated).toMatchObject({ budget: { activeElapsedMs: 125 } })
      expect(runtime.execution).toEqual(initial)
      throw failure
    })
    await f.service.generateScene(generationRequest)
    await expect(f.runNext()).rejects.toBe(failure)
    expect(f.executions.get('operation-1')).toMatchObject({
      state: 'failed',
      checkpointId: 'associated-checkpoint',
      budget: { activeElapsedMs: 125 }
    })
    expect(f.versions.commitCandidate).not.toHaveBeenCalled()
  })

  it('写入执行记录先追加去重时间线，再持久化、发布、读取检查点并通知订阅者', async () => {
    const f = createSceneGenerationFixture()
    await f.service.generateScene(generationRequest)
    const base = f.executions.get('operation-1')!
    const events: SceneGenerationRenderProgressEventVO[] = []
    const unsubscribe = f.coordinator.subscribeRenderProgress(generationRequest, (event) =>
      events.push(event)
    )
    const progressBefore = f.progress.length
    let progressAtPersist = -1
    const originalWrite = f.workflow.writeExecution.getMockImplementation()!
    f.workflow.writeExecution.mockImplementationOnce(async (execution) => {
      progressAtPersist = f.progress.length
      return originalWrite(execution)
    })
    let progressAtCheckpoint = -1
    const originalCheckpoint = f.workflow.readCheckpoint.getMockImplementation()!
    f.workflow.readCheckpoint.mockImplementationOnce(async (request) => {
      progressAtCheckpoint = f.progress.length
      return originalCheckpoint(request)
    })

    const interrupted = {
      ...base,
      state: 'interrupted' as const,
      step: undefined,
      checkpointId: 'checkpoint-1',
      candidateSnapshotId: 'snapshot-1',
      sequence: base.sequence + 1
    }
    const written = await f.coordinator.writeExecution(interrupted)

    expect(progressAtPersist).toBe(progressBefore)
    expect(progressAtCheckpoint).toBe(progressBefore + 1)
    expect(f.progress).toHaveLength(progressBefore + 1)
    expect(f.progress.at(-1)).toMatchObject({
      operationId: 'operation-1',
      state: 'interrupted',
      sequence: interrupted.sequence
    })
    expect(written.canContinue).toBe(true)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      operationId: 'operation-1',
      state: 'interrupted',
      sequence: interrupted.sequence,
      checkpointId: 'checkpoint-1',
      canResume: true,
      message: '已暂停，可继续'
    })
    const timeline = f.executions.get('operation-1')?.timeline ?? []
    expect(timeline).toHaveLength(1)
    expect(timeline[0]).toMatchObject({
      kind: 'stage',
      stage: 'paused',
      message: '已暂停，可继续',
      sequence: interrupted.sequence
    })

    await f.coordinator.writeExecution({
      ...f.executions.get('operation-1')!,
      sequence: interrupted.sequence + 1
    })
    expect(f.executions.get('operation-1')?.timeline).toHaveLength(1)
    expect(events).toHaveLength(2)
    expect(events.at(-1)?.sequence).toBe(interrupted.sequence + 1)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    f.workflow.readCheckpoint.mockRejectedValueOnce(new Error('检查点读取失败'))
    const withoutEligibility = await f.coordinator.writeExecution({
      ...f.executions.get('operation-1')!,
      sequence: interrupted.sequence + 2
    })
    warn.mockRestore()
    expect(withoutEligibility.canContinue).toBeUndefined()
    expect(events).toHaveLength(2)
    expect(f.progress).toHaveLength(progressBefore + 3)
    expect(f.executions.get('operation-1')?.sequence).toBe(interrupted.sequence + 2)
    unsubscribe()
  })

  it('执行时间线最多保留 64 条，阶段记录只保留最近 16 条', async () => {
    const f = createSceneGenerationFixture()
    await f.service.generateScene(generationRequest)
    const base = f.executions.get('operation-1')!
    const entry = (
      index: number,
      kind: SceneGenerationTimelineEntryVO['kind']
    ): SceneGenerationTimelineEntryVO => ({
      entryId: `old-${index}`,
      sequence: index,
      createdAt: new Date(0).toISOString(),
      kind,
      stage: kind === 'failure' ? ('failed' as const) : ('generating' as const),
      message: kind === 'failure' ? `旧失败 ${index}` : `旧阶段 ${index}`
    })

    await f.coordinator.writeExecution({
      ...base,
      state: 'interrupted',
      step: undefined,
      interruptReason: 'commitUnknown',
      sequence: base.sequence + 1,
      timeline: Array.from({ length: 80 }, (_, index) => entry(index + 1, 'failure'))
    })
    const capped = f.executions.get('operation-1')!.timeline!
    expect(capped).toHaveLength(64)
    expect(capped[0].message).toBe('旧失败 18')
    expect(capped.at(-1)).toMatchObject({
      kind: 'failure',
      stage: 'failed',
      message: '提交结果待核对'
    })

    await f.coordinator.writeExecution({
      ...f.executions.get('operation-1')!,
      state: 'running',
      step: 'reading',
      interruptReason: 'paused',
      sequence: base.sequence + 2,
      timeline: Array.from({ length: 20 }, (_, index) => entry(index + 1, 'stage'))
    })
    const trimmed = f.executions.get('operation-1')!.timeline!
    expect(trimmed).toHaveLength(17)
    expect(trimmed[0].message).toBe('旧阶段 5')
    expect(trimmed.slice(0, -1).every((item) => item.kind === 'stage')).toBe(true)
    expect(trimmed.at(-1)).toMatchObject({
      kind: 'stage',
      stage: 'validating',
      sequence: base.sequence + 2
    })
  })

  it('旧协调器订阅者按操作接收新协调器写入的进度，订阅表不随实例重置', async () => {
    const f = createSceneGenerationFixture()
    const subscribed = f.coordinator
    const events: SceneGenerationRenderProgressEventVO[] = []
    const otherEvents: SceneGenerationRenderProgressEventVO[] = []
    const unsubscribe = subscribed.subscribeRenderProgress(generationRequest, (event) =>
      events.push(event)
    )
    const unsubscribeOther = subscribed.subscribeRenderProgress(
      { ...generationRequest, operationId: 'operation-2' },
      (event) => otherEvents.push(event)
    )
    await f.service.generateScene(generationRequest)
    f.jobs.length = 0
    const restarted = f.restart()
    await expect(restarted.resumeSceneGeneration(generationRequest)).resolves.toMatchObject({
      state: 'pending'
    })
    await f.runNext()

    expect(events.length).toBeGreaterThan(0)
    expect(events.at(-1)).toMatchObject({
      operationId: 'operation-1',
      state: 'succeeded',
      sequence: f.executions.get('operation-1')?.sequence
    })
    const sequences = events.map((event) => event.sequence)
    expect(sequences).toEqual([...new Set(sequences)].sort((left, right) => left - right))
    expect(otherEvents).toEqual([])
    unsubscribe()
    unsubscribeOther()
  })

  it('模型或工具调用超过旧额度仍可提交，不按次数中止', async () => {
    const f = createSceneGenerationFixture()
    f.workflow.executeGeneration.mockResolvedValue({
      ...f.ready,
      budget: { ...f.ready.budget, modelCallsUsed: 11, toolCallsUsed: 21 }
    })
    await f.service.generateScene(generationRequest)
    await expect(f.runNext()).resolves.toBeUndefined()
    expect(f.versions.commitCandidate).toHaveBeenCalledTimes(1)
  })

  it('旧活跃时限到期不再中止生成，用户取消仍按取消结束', async () => {
    const f = createSceneGenerationFixture()
    f.workflow.executeGeneration.mockImplementation(async (runtime) => {
      expect(runtime.activeTimeoutSignal.aborted).toBe(false)
      return f.ready
    })
    await f.service.generateScene(generationRequest)
    await expect(f.runNext()).resolves.toBeUndefined()
    expect(f.executions.get('operation-1')?.state).toBe('succeeded')
  })

  it('丢弃回复接受后退出仍执行取消清理，不恢复模型生成', async () => {
    const f = createSceneGenerationFixture()
    waitForInteraction(f)
    const started = await f.service.generateScene(generationRequest)
    await f.runNext()
    await f.service.replySceneGenerationInteraction({
      ...replyRequest,
      threadId: started.threadId,
      branchId: started.branchId,
      reply: { kind: 'discard' }
    })
    f.jobs.length = 0
    await expect(f.restart().resumeSceneGeneration(generationRequest)).resolves.toMatchObject({
      state: 'cancelled'
    })
    expect(f.jobs).toHaveLength(0)
    expect(f.workflow.continueInteraction).not.toHaveBeenCalled()
  })

  it('丢弃候选不核对版本或锁定，重复丢弃返回原凭证且不写作品', async () => {
    const f = createSceneGenerationFixture()
    waitForInteraction(f)
    const started = await f.service.generateScene(generationRequest)
    await f.runNext()
    f.versions.inspectBaseline.mockClear()
    f.versions.inspectBaseline.mockRejectedValue(
      new SceneGenerationVersionConflict('目标场景已变化，不能覆盖')
    )
    const discard: ReplySceneGenerationInteractionDTO = {
      ...replyRequest,
      threadId: started.threadId,
      branchId: started.branchId,
      reply: { kind: 'discard' }
    }

    const first = await f.service.replySceneGenerationInteraction(discard)
    await expect(f.service.replySceneGenerationInteraction(discard)).resolves.toEqual(first)

    expect(first).toMatchObject({ replyId: 'reply-1', accepted: true })
    expect(f.versions.inspectBaseline).not.toHaveBeenCalled()
    expect(f.versions.commitCandidate).not.toHaveBeenCalled()
    expect(f.executions.get('operation-1')?.replies).toHaveLength(1)
  })

  it('成功提交后清理失败仍记录已保存结果，并向任务出口报告清理故障', async () => {
    const f = createSceneGenerationFixture()
    f.artifacts.discardWorkspace.mockRejectedValue(new Error('清理失败'))
    await f.service.generateScene(generationRequest)
    await expect(f.runNext()).rejects.toMatchObject({ code: 5103 })
    expect(f.executions.get('operation-1')).toMatchObject({
      state: 'succeeded',
      workspaceCleanupPending: true,
      workspace: expect.objectContaining({ workspaceId: 'operation-1' }),
      result: { commitId: 'commit-operation-1' },
      failure: { message: '作品已保存，但候选工作区清理未完成' }
    })
    expect(f.versions.rollbackCandidate).not.toHaveBeenCalled()
  })

  it('受控回退成功后保留回退修订，清理候选并报告原始失败', async () => {
    const f = createSceneGenerationFixture()
    const original = new Error('提交失败')
    f.versions.commitCandidate.mockRejectedValue(original)
    f.versions.readOperationCommit.mockResolvedValue({
      state: 'rollbackRequired',
      commitId: 'partial-commit'
    })
    await f.service.generateScene(generationRequest)
    await expect(f.runNext()).rejects.toBe(original)
    expect(f.executions.get('operation-1')).toMatchObject({
      state: 'failed',
      rollbackCommitId: 'rollback-1'
    })
    expect(f.artifacts.discardWorkspace).toHaveBeenCalledTimes(1)
  })

  it('接受回复后进程退出仍用持久回复继续，不重复记录消息', async () => {
    const f = createSceneGenerationFixture()
    waitForInteraction(f)
    const started = await f.service.generateScene(generationRequest)
    await f.runNext()
    await f.service.replySceneGenerationInteraction({
      ...replyRequest,
      threadId: started.threadId,
      branchId: started.branchId
    })
    f.jobs.length = 0
    await f.restart().resumeSceneGeneration(generationRequest)
    await f.runNext()
    expect(f.workflow.continueInteraction).toHaveBeenCalledTimes(1)
    expect(f.workflow.continueInteraction.mock.calls[0][0].execution.pendingReply?.replyId).toBe(
      'reply-1'
    )
    expect(f.executions.get('operation-1')?.replies).toHaveLength(1)
  })

  it('历史查询不执行模型或写状态，详情不返回内部执行、路径和凭据', async () => {
    const f = createSceneGenerationFixture()
    await f.service.generateScene(generationRequest)
    const execution = f.executions.get('operation-1')!
    const view = {
      ...execution,
      checkpointId: 'checkpoint-1',
      summary: '已生成',
      decisions: [],
      differences: [],
      canView: true,
      canContinue: true,
      canFork: true
    }
    f.workflow.readCheckpoint.mockResolvedValue({
      view,
      execution,
      candidateSnapshotId: 'snapshot-1'
    })
    const request = { ...execution, checkpointId: 'checkpoint-1' }
    const details = await f.service.readSceneGenerationCheckpoint(request)
    expect(details).not.toHaveProperty('source')
    expect(details).not.toHaveProperty('inputSnapshot')
    expect(details).not.toHaveProperty('fingerprint')
    await f.service.listSceneGenerationHistory({ ...execution, limit: 10 })
    expect(f.workflow.writeExecution).not.toHaveBeenCalled()
    expect(f.workflow.executeGeneration).not.toHaveBeenCalled()
  })

  it('历史详情只投影安全摘要与分叉资格，不从列表边界推断', async () => {
    const f = createSceneGenerationFixture()
    await f.service.generateScene(generationRequest)
    const stored = f.executions.get('operation-1')!
    const execution = { ...stored, updatedAt: '2026-10-21T10:24:00.000Z' }
    f.workflow.readCheckpoint.mockResolvedValue({
      execution,
      candidateSnapshotId: 'snapshot-1',
      view: {
        ...execution,
        checkpointId: 'checkpoint-1',
        phase: 'waiting',
        summary: '候选已发布，等待审阅',
        decisions: [],
        differences: [{ filePath: 'game/scene/start.txt' }],
        canView: true,
        canContinue: false,
        canFork: false,
        reason: '副作用结果尚未确认，不能分叉'
      }
    })
    const detail = await f.service.readSceneGenerationHistoryDetail({
      ...execution,
      checkpointId: 'checkpoint-1'
    })
    expect(detail).toMatchObject({
      checkpointId: 'checkpoint-1',
      canFork: false,
      forkReason: '副作用结果尚未确认，不能分叉'
    })
    expect(detail).not.toHaveProperty('differences')
    expect(detail).not.toHaveProperty('preview')
    expect(detail).not.toHaveProperty('source')
    expect(detail).not.toHaveProperty('inputSnapshot')
  })

  it('历史分叉的新建分支与操作，恢复历史文件而不回退正式工程，修改输入重新验证', async () => {
    const f = createSceneGenerationFixture()
    const original = await f.service.generateScene(generationRequest)
    await f.runNext()
    const committed = f.executions.get('operation-1')!
    const execution = { ...committed, state: 'waiting' as const, result: undefined }
    f.executions.set('operation-1', execution)
    const view = {
      ...original,
      checkpointId: 'checkpoint-1',
      phase: 'generating' as const,
      summary: '已生成',
      decisions: [],
      differences: [],
      canView: true,
      canContinue: true,
      canFork: true
    }
    f.workflow.readCheckpoint.mockResolvedValue({
      view,
      execution,
      candidateSnapshotId: 'snapshot-1'
    })
    const fork = await f.service.forkSceneGeneration({
      ...original,
      operationId: 'fork-1',
      checkpointId: 'checkpoint-1',
      policy: generationRequest.policy,
      inputChanges: generationRequest.inputs
    })
    expect(fork.branchId).not.toBe(original.branchId)
    expect(fork.forkFrom).toMatchObject({ summary: '已生成' })
    // 新操作在首个边界发布前不能继承来源检查点，否则同一场景历史会出现两个相同标识。
    const created = f.executions.get('fork-1')!
    expect(created.checkpointId).toBeUndefined()
    expect(created.fork?.checkpointId).toBe('checkpoint-1')
    await f.runNext()
    expect(f.artifacts.restoreWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: 'fork-1',
        replies: [],
        budget: { correctionsUsed: 0, modelCallsUsed: 0, toolCallsUsed: 0, activeElapsedMs: 0 }
      }),
      'snapshot-1'
    )
    expect(f.workflow.forkGeneration).toHaveBeenCalledTimes(1)
    expect(f.executions.get('operation-1')).toEqual(execution)
    expect(f.versions.rollbackCandidate).not.toHaveBeenCalled()
  })

  it('缺失或不兼容历史只允许查看，不建立分叉工作区', async () => {
    const f = createSceneGenerationFixture()
    const original = await f.service.generateScene(generationRequest)
    await f.runNext()
    const execution = f.executions.get('operation-1')!
    f.workflow.readCheckpoint.mockResolvedValue({
      execution,
      view: {
        ...original,
        checkpointId: 'checkpoint-1',
        phase: 'generating',
        summary: '旧记录',
        decisions: [],
        differences: [],
        canView: true,
        canContinue: false,
        canFork: false,
        reason: '候选快照缺失'
      }
    })
    await expect(
      f.service.forkSceneGeneration({
        ...original,
        operationId: 'fork-1',
        checkpointId: 'checkpoint-1',
        policy: generationRequest.policy
      })
    ).rejects.toMatchObject({ code: 4103 })
    expect(f.artifacts.restoreWorkspace).not.toHaveBeenCalled()
    expect(f.executions.has('fork-1')).toBe(false)
  })

  it('历史分叉建立当前作品基线，并在启动后退出时保留输入和决策修改', async () => {
    const f = createSceneGenerationFixture()
    const original = await f.service.generateScene(generationRequest)
    await f.runNext()
    const committed = f.executions.get('operation-1')!
    const execution = { ...committed, state: 'waiting' as const, result: undefined }
    f.executions.set('operation-1', execution)
    f.workflow.readCheckpoint.mockResolvedValue({
      execution,
      candidateSnapshotId: 'snapshot-1',
      view: {
        ...original,
        checkpointId: 'checkpoint-1',
        phase: 'generating',
        summary: '历史',
        decisions: [],
        differences: [],
        canView: true,
        canContinue: true,
        canFork: true
      }
    })
    f.versions.readBaseline.mockResolvedValue({
      ...execution.baseline,
      commitId: 'current-baseline'
    })
    const forkRequest = {
      ...original,
      operationId: 'fork-1',
      checkpointId: 'checkpoint-1',
      policy: generationRequest.policy,
      decisionChanges: [
        {
          interactionId: 'historical-interaction',
          reply: { kind: 'revise' as const, body: '改变结尾' }
        }
      ]
    }
    await f.service.forkSceneGeneration(forkRequest)
    f.jobs.length = 0
    await f.restart().resumeSceneGeneration(forkRequest)
    await f.runNext()
    expect(f.workflow.forkGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        execution: expect.objectContaining({
          baseline: expect.objectContaining({ commitId: 'current-baseline' })
        })
      }),
      forkRequest
    )
    expect(f.workflow.resumeGeneration).not.toHaveBeenCalled()
  })

  it('记忆清理拒绝运行与等待线程，已结束线程只调用记忆清理端口', async () => {
    const f = createSceneGenerationFixture()
    const started = await f.service.generateScene(generationRequest)
    await expect(f.service.clearSceneGenerationMemory(started)).rejects.toMatchObject({
      code: 4103
    })
    waitForInteraction(f)
    await f.runNext()
    await expect(f.service.clearSceneGenerationMemory(started)).rejects.toMatchObject({
      code: 4103
    })
    await f.service.cancelSceneGeneration(generationRequest)
    await expect(f.service.clearSceneGenerationMemory(started)).resolves.toEqual({
      threadId: started.threadId,
      cleared: true
    })
    expect(f.workflow.clearMemory).toHaveBeenCalledTimes(1)
    expect(f.versions.rollbackCandidate).not.toHaveBeenCalled()
  })

  it('不同工程或场景不能查询或取消同一操作', async () => {
    const f = createSceneGenerationFixture()
    await f.service.generateScene(generationRequest)
    await expect(
      f.service.getSceneGenerationStatus({ ...generationRequest, projectId: 'other-project' })
    ).rejects.toMatchObject({ code: 4101 })
    await expect(
      f.service.cancelSceneGeneration({ ...generationRequest, sceneId: 'other-scene' })
    ).rejects.toMatchObject({ code: 4101 })
    expect(f.artifacts.discardWorkspace).not.toHaveBeenCalled()
  })

  it('状态和历史查询不核对工作区', async () => {
    const f = createSceneGenerationFixture()
    await f.service.generateScene(generationRequest)
    f.versions.ensureWorkspace.mockClear()
    await f.service.getSceneGenerationStatus(generationRequest)
    await f.service.listSceneGenerationHistoryForScene({
      projectId: generationRequest.projectId,
      sceneId: generationRequest.sceneId,
      limit: 1
    })
    expect(f.versions.ensureWorkspace).not.toHaveBeenCalled()
  })

  it('进程中断沿原操作、线程和分支恢复，取消后不自动续跑', async () => {
    const f = createSceneGenerationFixture()
    await f.service.generateScene(generationRequest)
    await f.runNext()
    const started = f.executions.get('operation-1')!
    f.executions.set('operation-1', {
      ...started,
      state: 'running',
      checkpointId: 'checkpoint-1',
      candidateSnapshotId: 'snapshot-1',
      workspace: {
        workspaceId: 'operation-1',
        rootDirectory: '/candidate/operation-1',
        sceneDirectory: 'scenes/scene-1'
      }
    })
    f.commits.delete('operation-1')
    const restarted = f.restart()
    const status = await restarted.resumeSceneGeneration(generationRequest)
    expect(status.state).toBe('pending')
    expect(f.jobs).toHaveLength(1)
    await f.runNext()
    expect(f.workflow.resumeGeneration).toHaveBeenCalledTimes(1)
    expect(f.artifacts.restoreWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: 'operation-1',
        threadId: started.threadId,
        branchId: started.branchId
      }),
      'snapshot-1'
    )
    expect(f.workflow.executeGeneration).toHaveBeenCalledTimes(1)

    f.executions.set('operation-1', {
      ...f.executions.get('operation-1')!,
      state: 'cancelled',
      step: undefined,
      cancellationRequested: true
    })
    f.jobs.length = 0
    await expect(f.restart().resumeSceneGeneration(generationRequest)).resolves.toMatchObject({
      state: 'cancelled'
    })
    expect(f.jobs).toHaveLength(0)
    expect(f.workflow.resumeGeneration).toHaveBeenCalledTimes(1)
  })

  it('失败修复重跑新建线程并持久化来源上下文，不把旧候选当新工作区候选', async () => {
    const f = createSceneGenerationFixture()
    await f.service.generateScene(generationRequest)
    await f.runNext()
    const source = f.executions.get('operation-1')!
    f.executions.set('operation-1', {
      ...source,
      state: 'failed',
      step: undefined,
      checkpointId: 'checkpoint-1',
      candidateSnapshotId: 'snapshot-1',
      artifactValidation: {
        issues: [
          {
            code: 'missing-background',
            message: '缺少背景',
            correctable: true,
            requiresHumanDecision: false
          }
        ]
      },
      failure: { code: 4101, message: '候选未通过', failureClass: 'outputContract' },
      replies: [
        {
          ...source,
          interactionId: 'interaction-1',
          checkpointId: 'checkpoint-1',
          candidateSnapshotId: 'snapshot-1',
          replyId: 'reply-1',
          reply: { kind: 'revise', body: '改结尾' }
        }
      ]
    })
    f.commits.delete('operation-1')
    const retried = await f.generation.retryFailedRepair({
      projectId: 'project-1',
      sceneId: 'scene-1',
      canvasId: 'canvas-1',
      confirmedControls: [],
      policy: { maxCorrections: 2 },
      operationId: 'operation-2',
      repair: {
        sourceOperationId: 'operation-1',
        sourceThreadId: source.threadId,
        sourceBranchId: source.branchId,
        sourceCheckpointId: 'checkpoint-1',
        candidateSnapshotId: 'snapshot-1',
        instruction: '改结尾'
      }
    })
    expect(retried.operationId).toBe('operation-2')
    expect(retried.threadId).not.toBe(source.threadId)
    expect(retried.branchId).not.toBe(source.branchId)
    expect(f.executions.get('operation-1')?.state).toBe('failed')
    const created = f.executions.get('operation-2')
    expect(created).toMatchObject({
      mode: 'repair',
      repairSource: {
        operationId: 'operation-1',
        threadId: source.threadId,
        branchId: source.branchId,
        checkpointId: 'checkpoint-1',
        candidateSnapshotId: 'snapshot-1'
      },
      repairContext: {
        sourceOperationId: 'operation-1',
        sourceThreadId: source.threadId,
        sourceBranchId: source.branchId,
        sourceCheckpointId: 'checkpoint-1',
        sourceCandidateSnapshotId: 'snapshot-1',
        candidatePath: 'scenes/scene-1/start.txt',
        instruction: '改结尾',
        summary: '来源摘要',
        confirmedReplies: [{ kind: 'revise', body: '改结尾' }],
        unresolvedIssues: ['未解决冲突'],
        failureClass: 'outputContract',
        failureMessage: '候选未通过'
      },
      replies: []
    })
    expect(created?.repairContext?.validationReport).toEqual({
      issues: [expect.objectContaining({ code: 'missing-background' })]
    })
    expect(created?.candidateSnapshotId).toBeUndefined()
    await f.runNext()
    expect(f.artifacts.materializeRepairInput).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: 'operation-2', threadId: retried.threadId }),
      expect.objectContaining({ threadId: source.threadId, candidateSnapshotId: 'snapshot-1' })
    )
    expect(f.artifacts.restoreWorkspace).not.toHaveBeenCalled()
    expect(
      f.workflow.executeGeneration.mock.calls.at(-1)?.[0].execution.repairInputSnapshotId
    ).toBe('repair-input-1')
    expect(f.workflow.executeGeneration.mock.calls.at(-1)?.[0].execution.candidateSnapshotId).toBe(
      undefined
    )
    expect(f.workflow.executeGeneration.mock.calls.at(-1)?.[0].execution.mode).toBe('repair')
  })

  it('修复输入已由上一进程发布时按工作区证据复用，不重复物化', async () => {
    const f = createSceneGenerationFixture()
    await f.service.generateScene(generationRequest)
    await f.runNext()
    const source = f.executions.get('operation-1')!
    f.executions.set('operation-1', {
      ...source,
      state: 'failed',
      step: undefined,
      checkpointId: 'checkpoint-1',
      candidateSnapshotId: 'snapshot-1',
      artifactValidation: { issues: [] },
      replies: [
        {
          ...source,
          interactionId: 'interaction-1',
          checkpointId: 'checkpoint-1',
          candidateSnapshotId: 'snapshot-1',
          replyId: 'reply-1',
          reply: { kind: 'revise', body: '改结尾' }
        }
      ]
    })
    f.commits.delete('operation-1')
    f.artifacts.createWorkspace.mockClear()
    f.artifacts.restoreWorkspace.mockClear()
    f.artifacts.proveRepairInput.mockResolvedValueOnce({
      workspaceId: 'operation-2',
      rootDirectory: '/proven/operation-2',
      sceneDirectory: 'scenes/scene-1',
      candidateSnapshotId: 'repair-input-proven'
    })

    await f.generation.retryFailedRepair({
      projectId: 'project-1',
      sceneId: 'scene-1',
      canvasId: 'canvas-1',
      confirmedControls: [],
      policy: { maxCorrections: 2 },
      operationId: 'operation-2',
      repair: {
        sourceOperationId: 'operation-1',
        sourceThreadId: source.threadId,
        sourceBranchId: source.branchId,
        sourceCheckpointId: 'checkpoint-1',
        candidateSnapshotId: 'snapshot-1',
        instruction: '改结尾'
      }
    })
    await f.runNext()

    expect(f.artifacts.proveRepairInput).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: 'operation-2' }),
      expect.objectContaining({ candidateSnapshotId: 'snapshot-1' })
    )
    expect(f.artifacts.materializeRepairInput).not.toHaveBeenCalled()
    expect(f.artifacts.createWorkspace).not.toHaveBeenCalled()
    expect(f.artifacts.restoreWorkspace).not.toHaveBeenCalled()
    const passed = f.workflow.executeGeneration.mock.calls.at(-1)?.[0].execution
    expect(passed?.repairInputSnapshotId).toBe('repair-input-proven')
    expect(passed?.workspace?.rootDirectory).toBe('/proven/operation-2')
    expect(passed?.candidateSnapshotId).toBeUndefined()
    expect(passed?.mode).toBe('repair')
  })

  it('源检查点缺失或身份不一致时拒绝重跑，不创建新操作', async () => {
    const f = createSceneGenerationFixture()
    await f.service.generateScene(generationRequest)
    await f.runNext()
    const source = f.executions.get('operation-1')!
    f.executions.set('operation-1', {
      ...source,
      state: 'failed',
      step: undefined,
      checkpointId: 'checkpoint-1',
      candidateSnapshotId: 'snapshot-1',
      replies: [
        {
          ...source,
          interactionId: 'interaction-1',
          checkpointId: 'checkpoint-1',
          candidateSnapshotId: 'snapshot-1',
          replyId: 'reply-1',
          reply: { kind: 'revise', body: '改结尾' }
        }
      ]
    })
    f.jobs.length = 0
    const request = {
      projectId: 'project-1',
      sceneId: 'scene-1',
      canvasId: 'canvas-1',
      confirmedControls: [],
      policy: { maxCorrections: 2 },
      operationId: 'operation-2',
      repair: {
        sourceOperationId: 'operation-1',
        sourceThreadId: source.threadId,
        sourceBranchId: source.branchId,
        sourceCheckpointId: 'checkpoint-1',
        candidateSnapshotId: 'snapshot-1',
        instruction: '改结尾'
      }
    }
    f.workflow.readCheckpoint.mockResolvedValue({
      execution: { ...f.executions.get('operation-1')!, operationId: 'other-operation' },
      candidateSnapshotId: 'snapshot-1',
      view: {
        ...source,
        checkpointId: 'checkpoint-1',
        phase: 'failed',
        summary: '来源摘要',
        decisions: [],
        differences: [],
        canView: true,
        canContinue: false
      }
    })
    await expect(f.generation.retryFailedRepair(request)).rejects.toMatchObject({
      code: 4103,
      message: '来源修复上下文不完整，已保留原失败记录'
    })
    expect(f.executions.has('operation-2')).toBe(false)
    expect(f.jobs).toHaveLength(0)

    f.workflow.readCheckpoint.mockRejectedValue(new Error('检查点缺失'))
    await expect(f.generation.retryFailedRepair(request)).rejects.toMatchObject({
      code: 4103,
      message: '来源修复上下文不完整，已保留原失败记录'
    })
    expect(f.executions.has('operation-2')).toBe(false)
    expect(f.jobs).toHaveLength(0)
  })

  it('来源未解决冲突超量时拒绝修复重跑，不创建新操作', async () => {
    const f = createSceneGenerationFixture()
    await f.service.generateScene(generationRequest)
    await f.runNext()
    const source = f.executions.get('operation-1')!
    f.executions.set('operation-1', {
      ...source,
      state: 'failed',
      step: undefined,
      checkpointId: 'checkpoint-1',
      candidateSnapshotId: 'snapshot-1',
      replies: [
        {
          ...source,
          interactionId: 'interaction-1',
          checkpointId: 'checkpoint-1',
          candidateSnapshotId: 'snapshot-1',
          replyId: 'reply-1',
          reply: { kind: 'revise', body: '改结尾' }
        }
      ]
    })
    f.jobs.length = 0
    const request = {
      projectId: 'project-1',
      sceneId: 'scene-1',
      canvasId: 'canvas-1',
      confirmedControls: [],
      policy: { maxCorrections: 2 },
      operationId: 'operation-2',
      repair: {
        sourceOperationId: 'operation-1',
        sourceThreadId: source.threadId,
        sourceBranchId: source.branchId,
        sourceCheckpointId: 'checkpoint-1',
        candidateSnapshotId: 'snapshot-1',
        instruction: '改结尾'
      }
    }
    const checkpointOf = (
      unresolvedIssues: readonly string[]
    ): Partial<WebGalGenerationStateValue> => ({
      execution: f.executions.get('operation-1')!,
      candidateSnapshotId: 'snapshot-1',
      summary: '来源摘要',
      unresolvedIssues,
      view: {
        ...source,
        checkpointId: 'checkpoint-1',
        phase: 'failed',
        summary: '来源摘要',
        decisions: [],
        differences: [],
        canView: true,
        canContinue: false
      }
    })

    f.workflow.readCheckpoint.mockResolvedValue(
      checkpointOf(Array.from({ length: 101 }, (_, index) => `冲突 ${index + 1}`))
    )
    await expect(f.generation.retryFailedRepair(request)).rejects.toMatchObject({
      code: 4103,
      message: '来源修复上下文过大，已保留原失败记录'
    })
    expect(f.executions.has('operation-2')).toBe(false)
    expect(f.jobs).toHaveLength(0)

    f.workflow.readCheckpoint.mockResolvedValue(checkpointOf(['冲'.repeat(501)]))
    await expect(f.generation.retryFailedRepair(request)).rejects.toMatchObject({
      code: 4103,
      message: '来源修复上下文过大，已保留原失败记录'
    })
    expect(f.executions.has('operation-2')).toBe(false)
    expect(f.jobs).toHaveLength(0)
  })

  it('链式重试以最近失败操作为来源，携带它自己的摘要与失败原因', async () => {
    const f = createSceneGenerationFixture()
    await f.service.generateScene(generationRequest)
    await f.runNext()
    const source = f.executions.get('operation-1')!
    f.executions.set('operation-1', {
      ...source,
      mode: 'repair',
      state: 'failed',
      step: undefined,
      checkpointId: 'checkpoint-f',
      candidateSnapshotId: 'snapshot-f',
      repairSource: {
        operationId: 'operation-earlier',
        threadId: 'thread-earlier',
        branchId: 'branch-earlier',
        checkpointId: 'checkpoint-earlier',
        candidateSnapshotId: 'snapshot-earlier'
      },
      failure: { code: 4101, message: '最近一次失败', failureClass: 'outputContract' },
      replies: [
        {
          ...source,
          interactionId: 'interaction-f',
          checkpointId: 'checkpoint-f',
          candidateSnapshotId: 'snapshot-f',
          replyId: 'reply-f',
          reply: { kind: 'revise', body: '再改结尾' }
        }
      ]
    })
    f.workflow.readCheckpoint.mockResolvedValue({
      execution: f.executions.get('operation-1')!,
      candidateSnapshotId: 'snapshot-f',
      summary: '最近失败摘要',
      unresolvedIssues: ['最近失败冲突'],
      view: {
        ...source,
        operationId: 'operation-1',
        checkpointId: 'checkpoint-f',
        phase: 'failed',
        summary: '最近失败摘要',
        decisions: [],
        differences: [],
        canView: true,
        canContinue: false
      }
    })
    f.jobs.length = 0
    await f.generation.retryFailedRepair({
      projectId: 'project-1',
      sceneId: 'scene-1',
      canvasId: 'canvas-1',
      confirmedControls: [],
      policy: { maxCorrections: 2 },
      operationId: 'operation-2',
      repair: {
        sourceOperationId: 'operation-1',
        sourceThreadId: source.threadId,
        sourceBranchId: source.branchId,
        sourceCheckpointId: 'checkpoint-f',
        candidateSnapshotId: 'snapshot-f',
        instruction: '再改结尾'
      }
    })
    const created = f.executions.get('operation-2')!
    expect(created.mode).toBe('repair')
    expect(created.repairSource).toMatchObject({
      operationId: 'operation-1',
      checkpointId: 'checkpoint-f',
      candidateSnapshotId: 'snapshot-f'
    })
    expect(created.repairContext).toMatchObject({
      sourceOperationId: 'operation-1',
      sourceCheckpointId: 'checkpoint-f',
      sourceCandidateSnapshotId: 'snapshot-f',
      instruction: '再改结尾',
      summary: '最近失败摘要',
      unresolvedIssues: ['最近失败冲突'],
      failureClass: 'outputContract',
      failureMessage: '最近一次失败'
    })
    expect(created.replies).toEqual([])
  })

  it('来源身份不匹配或已取消时拒绝修复重跑，原记录保持不变', async () => {
    const f = createSceneGenerationFixture()
    await f.service.generateScene(generationRequest)
    const source = f.executions.get('operation-1')!
    f.executions.set('operation-1', {
      ...source,
      state: 'cancelled',
      step: undefined,
      checkpointId: 'checkpoint-1',
      candidateSnapshotId: 'snapshot-1',
      replies: [
        {
          ...source,
          interactionId: 'interaction-1',
          checkpointId: 'checkpoint-1',
          replyId: 'reply-1',
          reply: { kind: 'revise', body: '改结尾' }
        }
      ]
    })
    const request = {
      projectId: 'project-1',
      sceneId: 'scene-1',
      canvasId: 'canvas-1',
      confirmedControls: [],
      policy: { maxCorrections: 2 },
      operationId: 'operation-2',
      repair: {
        sourceOperationId: 'operation-1',
        sourceThreadId: source.threadId,
        sourceBranchId: source.branchId,
        sourceCheckpointId: 'checkpoint-1',
        candidateSnapshotId: 'snapshot-1',
        instruction: '改结尾'
      }
    }
    await expect(f.generation.retryFailedRepair(request)).rejects.toMatchObject({ code: 4103 })
    f.executions.set('operation-1', { ...f.executions.get('operation-1')!, state: 'failed' })
    await expect(
      f.generation.retryFailedRepair({
        ...request,
        repair: { ...request.repair, sourceThreadId: 'other-thread' }
      })
    ).rejects.toMatchObject({ code: 4103 })
    expect(f.executions.has('operation-2')).toBe(false)
    expect(f.jobs).toHaveLength(1)
  })
})
