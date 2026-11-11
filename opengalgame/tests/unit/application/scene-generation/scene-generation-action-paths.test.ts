import { describe, expect, it } from 'vitest'

import { toRenderStatusVO } from '@application/scene-generation/mapping/SceneGenerationRenderProjection'
import { SceneGenerationLaunchServiceImpl } from '@application/scene-generation/services/impl/SceneGenerationLaunchServiceImpl'
import type { SceneGenerationRenderDependencies } from '@application/scene-generation/services/impl/SceneGenerationRenderDependencies'
import type { SceneGenerationApplicationService } from '@application/scene-generation/services/SceneGenerationApplicationService'
import type { SceneCanvasArrangementVO } from '@application/scene-canvas/vo/SceneCanvasArrangementVO'
import {
  repairRetryViewOf,
  retryRepairRequestOf
} from '@presentation/pages/workbench/drawer/generation/generationPresentation'

import type { ReplySceneGenerationInteractionDTO } from '@application/scene-generation/dto/SceneGenerationDTO'
import type { SceneGenerationExecution } from '@application/scene-generation/models/SceneGenerationExecution'

import {
  createSceneGenerationFixture,
  generationRequest,
  waitForInteraction,
  waitingInteraction
} from './sceneGenerationFixture'

const instruction = '把结尾改得温暖一些'
const scope = { projectId: 'project-1', sceneId: 'scene-1' }

/** 构造一条已确认的修改回复；身份与来源执行一致。 */
function reviseReply(
  source: SceneGenerationExecution,
  body: string,
  replyId: string
): ReplySceneGenerationInteractionDTO {
  return {
    projectId: source.projectId,
    sceneId: source.sceneId,
    operationId: source.operationId,
    threadId: source.threadId,
    branchId: source.branchId,
    interactionId: 'interaction-1',
    checkpointId: 'checkpoint-1',
    candidateSnapshotId: 'snapshot-1',
    replyId,
    reply: { kind: 'revise', body }
  }
}

/** 构造一条已确认的澄清回复；只用于轮次边界。 */
function clarifyReply(
  source: SceneGenerationExecution,
  body: string,
  replyId: string
): ReplySceneGenerationInteractionDTO {
  return {
    ...reviseReply(source, body, replyId),
    reply: { kind: 'clarify', body }
  }
}

describe('场景生成动作分路径', () => {
  it('继续修改沿用原操作、线程、分支和检查点，只追加已确认修改', async () => {
    const f = createSceneGenerationFixture()
    waitForInteraction(f)
    const started = await f.service.generateScene(generationRequest)
    await f.runNext()
    const before = f.executions.get('operation-1')
    expect(before).toMatchObject({
      state: 'waiting',
      checkpointId: waitingInteraction.checkpointId,
      mode: 'generate',
      replies: []
    })

    await f.service.replySceneGenerationInteraction({
      ...generationRequest,
      threadId: started.threadId,
      branchId: started.branchId,
      interactionId: waitingInteraction.interactionId,
      checkpointId: waitingInteraction.checkpointId,
      candidateSnapshotId: waitingInteraction.candidateSnapshotId,
      replyId: 'reply-revise-1',
      reply: { kind: 'revise', body: instruction }
    })

    const after = f.executions.get('operation-1')!
    expect(after.operationId).toBe(before!.operationId)
    expect(after.threadId).toBe(before!.threadId)
    expect(after.branchId).toBe(before!.branchId)
    expect(after.checkpointId).toBe(before!.checkpointId)
    expect(after.mode).toBe('generate')
    expect(after.replies).toHaveLength(1)
    expect(after.replies[0].reply).toEqual({ kind: 'revise', body: instruction })
    expect(after.repairSource).toBeUndefined()
    expect(after.repairContext).toBeUndefined()
  })

  it('失败后重试本次修改新建操作并携带来源上下文，不伪造修改回复', async () => {
    const f = createSceneGenerationFixture()
    await f.service.generateScene(generationRequest)
    await f.runNext()
    const source = f.executions.get('operation-1')!
    f.executions.set('operation-1', {
      ...source,
      state: 'failed',
      phase: 'failed',
      checkpointId: 'checkpoint-1',
      candidateSnapshotId: 'snapshot-1',
      failure: { code: 4101, message: '候选未通过', failureClass: 'outputContract' },
      replies: [reviseReply(source, instruction, 'reply-1')]
    })

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
        instruction
      }
    })

    expect(retried.operationId).toBe('operation-2')
    expect(retried.threadId).not.toBe(source.threadId)
    expect(retried.branchId).not.toBe(source.branchId)
    expect(f.executions.get('operation-1')).toMatchObject({
      state: 'failed',
      replies: [{ replyId: 'reply-1' }]
    })

    const created = f.executions.get('operation-2')!
    expect(created).toMatchObject({
      mode: 'repair',
      replies: [],
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
        instruction
      }
    })
    expect(created.repairContext?.confirmedReplies).toEqual([{ kind: 'revise', body: instruction }])
  })

  it('按画布重新生成创建干净的生成操作，不继承修复来源', async () => {
    const f = createSceneGenerationFixture()
    const first = await f.service.generateScene(generationRequest)
    await f.runNext()
    const regenerated = await f.service.generateScene({
      ...generationRequest,
      operationId: 'operation-2'
    })

    expect(regenerated.operationId).toBe('operation-2')
    expect(regenerated.threadId).not.toBe(first.threadId)
    expect(regenerated.branchId).not.toBe(first.branchId)
    const created = f.executions.get('operation-2')!
    expect(created).toMatchObject({ mode: 'generate', replies: [] })
    expect(created.repairSource).toBeUndefined()
    expect(created.repairContext).toBeUndefined()
    expect(created.checkpointId).toBeUndefined()

    await f.runNext()
    const completed = f.executions.get('operation-2')!
    expect(completed.operationId).toBe('operation-2')
    expect(completed.checkpointId).toBe(f.ready.checkpointId)
  })

  it('修复重试的指令通过既有用户消息投影，不补造旧记录', async () => {
    const f = createSceneGenerationFixture()
    await f.service.generateScene(generationRequest)
    await f.runNext()
    const source = f.executions.get('operation-1')!
    f.executions.set('operation-1', {
      ...source,
      state: 'failed',
      phase: 'failed',
      checkpointId: 'checkpoint-1',
      candidateSnapshotId: 'snapshot-1',
      failure: { code: 4101, message: '候选未通过' },
      replies: [reviseReply(source, instruction, 'reply-1')]
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
        instruction
      }
    })
    const created = f.executions.get('operation-2')!

    const status = toRenderStatusVO(created)
    expect(status.userMessages).toEqual([{ kind: 'revise', body: instruction, round: 1 }])

    const failed = {
      ...created,
      state: 'failed' as const,
      phase: 'failed' as const,
      checkpointId: 'checkpoint-2',
      candidateSnapshotId: 'snapshot-2',
      failure: { code: 4101, message: '候选未通过' }
    }
    const failedStatus = toRenderStatusVO(failed)
    expect(failedStatus.failure?.unverified).toBe(false)
    expect(repairRetryViewOf(failedStatus)).toMatchObject({
      isRepair: true,
      eligible: true,
      instruction,
      blocker: null
    })
    // 链式重试的来源是这次失败操作自身，而不是它的 repairSource。
    expect(retryRepairRequestOf(failedStatus, scope)?.repair).toMatchObject({
      sourceOperationId: 'operation-2',
      sourceThreadId: created.threadId,
      sourceBranchId: created.branchId,
      sourceCheckpointId: 'checkpoint-2',
      candidateSnapshotId: 'snapshot-2',
      instruction
    })

    expect(toRenderStatusVO({ ...created, replies: [] }).userMessages).toEqual([
      { kind: 'revise', body: instruction, round: 1 }
    ])
    // 修复指令最先生效；后续修改顺延且不吞掉首条指令。
    expect(
      toRenderStatusVO({
        ...created,
        replies: [reviseReply(created, '另一条修改', 'reply-2')]
      }).userMessages
    ).toEqual([
      { kind: 'revise', body: instruction, round: 1 },
      { kind: 'revise', body: '另一条修改', round: 2 }
    ])
    // 澄清按发生顺序排在指令之后。
    expect(
      toRenderStatusVO({
        ...created,
        replies: [clarifyReply(created, '先补充说明', 'reply-clarify-1')]
      }).userMessages
    ).toEqual([
      { kind: 'revise', body: instruction, round: 1 },
      { kind: 'clarify', body: '先补充说明', round: 2 }
    ])
    // 与指令同文的修改只投影一次。
    expect(
      toRenderStatusVO({
        ...created,
        replies: [reviseReply(created, instruction, 'reply-same')]
      }).userMessages
    ).toEqual([{ kind: 'revise', body: instruction, round: 1 }])
    expect(toRenderStatusVO({ ...created, repairContext: undefined }).userMessages).toBeUndefined()

    const capped = {
      ...created,
      replies: Array.from({ length: 64 }, (_, index) =>
        clarifyReply(created, `澄清 ${index + 1}`, `reply-clarify-${index + 1}`)
      )
    }
    const cappedMessages = toRenderStatusVO(capped).userMessages ?? []
    expect(cappedMessages).toHaveLength(64)
    expect(cappedMessages[0]).toEqual({ kind: 'revise', body: instruction, round: 1 })
    expect(cappedMessages[1]).toEqual({ kind: 'clarify', body: '澄清 2', round: 2 })
    expect(cappedMessages.at(-1)?.round).toBe(64)
  })

  it('启动层缺少修复上下文时拒绝重跑，不伪装成已绑定', async () => {
    const f = createSceneGenerationFixture()
    await f.service.generateScene(generationRequest)
    await f.runNext()
    const source = f.executions.get('operation-1')!
    f.executions.set('operation-1', {
      ...source,
      state: 'failed',
      phase: 'failed',
      checkpointId: 'checkpoint-1',
      candidateSnapshotId: 'snapshot-1',
      replies: [reviseReply(source, instruction, 'reply-1')]
    })
    const arrangement: SceneCanvasArrangementVO = {
      projectId: 'project-1',
      sceneId: 'scene-1',
      canvasId: 'canvas-1',
      viewport: { x: 0, y: 0, zoom: 1 },
      cards: [],
      relations: []
    }
    const renderDeps: SceneGenerationRenderDependencies = {
      canvasVersions: {
        keepArrangement: async () => ({ state: 'kept' }),
        readSettlement: async () => ({ state: 'kept' }),
        readArrangementVersion: async () => ({
          projectId: 'project-1',
          sceneId: 'scene-1',
          canvasId: 'canvas-1',
          arrangementVersion: 'arrangement-1'
        })
      },
      saveArrangement: async () => {},
      readCurrentArrangement: async () => arrangement,
      production: {
        resolveRegisteredScene: async () => ({
          projectId: 'project-1',
          sceneId: 'scene-1',
          projectRoot: '/project',
          sceneDirectory: 'scenes/scene-1',
          entryFile: 'start.txt'
        })
      },
      preview: {
        openPublishedCandidatePreview: async () => {
          throw new Error('预览不属于本测试')
        },
        closeCandidatePreview: async () => {},
        invalidateCandidatePreviewSessions: async () => {},
        subscribeCandidatePreviewEvents: () => () => undefined,
        readCandidatePreviewEvent: () => undefined
      }
    }
    const generation = {
      async retryFailedRepair(request: { operationId: string }) {
        f.executions.set(request.operationId, {
          ...f.executions.get('operation-1')!,
          operationId: request.operationId,
          threadId: 'thread-repair',
          branchId: 'branch-repair',
          state: 'pending',
          mode: 'repair',
          repairSource: {
            operationId: 'operation-1',
            threadId: source.threadId,
            branchId: source.branchId,
            checkpointId: 'checkpoint-1',
            candidateSnapshotId: 'snapshot-1'
          },
          repairContext: undefined,
          replies: []
        })
        return { operationId: request.operationId }
      }
    } as unknown as SceneGenerationApplicationService
    const launch = new SceneGenerationLaunchServiceImpl(
      f.deps,
      renderDeps,
      generation,
      f.coordinator
    )

    await expect(
      launch.retrySceneGenerationRepair({
        projectId: 'project-1',
        sceneId: 'scene-1',
        canvasId: 'canvas-1',
        confirmedControls: [],
        policy: { maxCorrections: 2 },
        repair: {
          sourceOperationId: 'operation-1',
          sourceThreadId: source.threadId,
          sourceBranchId: source.branchId,
          sourceCheckpointId: 'checkpoint-1',
          candidateSnapshotId: 'snapshot-1',
          instruction
        }
      })
    ).rejects.toMatchObject({
      code: 4103,
      message: '修复重跑没有绑定来源上下文'
    })
  })
})
