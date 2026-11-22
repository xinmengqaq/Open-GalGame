/**
 * 代码门阻断 1 的真实装配回归：A 等待（有检查点）→ 从 A 分叉并接受 B →
 * B 为当前终态时 A 仍进入发现列表并阻止普通启动；处理 A 后再生成 C 至终态。
 * 真实仓储、状态投影和 controller/client；模型只由夹具脚本替身提供。
 */
import { expect, it } from 'vitest'

import type { SceneGenerationScopeDTO } from '@application/scene-generation/dto/SceneGenerationDTO'
import type { SceneGenerationExecution } from '@application/scene-generation/models/SceneGenerationExecution'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { LoggerGateway } from '@common/logging/LoggerGateway'
import type { DesktopBridge } from '@interfaces/client/DesktopBridge'
import { IpcErrorMapper } from '@interfaces/ipc/errors/IpcErrorMapper'
import { IpcExceptionHandler } from '@interfaces/ipc/errors/IpcExceptionHandler'
import { SceneGenerationClientImpl } from '@interfaces/scene-generation/client/SceneGenerationClientImpl'
import {
  SceneGenerationController,
  type SceneGenerationApplicationGateway
} from '@interfaces/scene-generation/ipc/SceneGenerationController'
import {
  startBlockedReason,
  startBlockingOperationOf
} from '@presentation/pages/workbench/drawer/generation/generationPresentation'
import {
  readGenerationHistory,
  unfinishedSelectionOf
} from '@presentation/pages/workbench/drawer/generation/useGenerationStatus'
import {
  generationFixture,
  request,
  validScript,
  type GenerationFixture
} from '../../../../harness/acceptance/support/generationFixture'

const access = { trusted: true, requestId: 'start-blocking-discovery' }
const forkScript = 'changeBg:station.svg;\n林:分叉后的台词 -clear;\nend;'
const projectId = request.projectId
const sceneId = request.sceneId

function identityOf(execution: SceneGenerationExecution): SceneGenerationScopeDTO & {
  threadId: string
  branchId: string
} {
  return {
    projectId: execution.projectId,
    sceneId: execution.sceneId,
    operationId: execution.operationId,
    threadId: execution.threadId,
    branchId: execution.branchId
  }
}

async function readExecution(
  app: GenerationFixture['app'],
  operationId: string
): Promise<SceneGenerationExecution> {
  const execution = await app.ports.executions.readExecution({
    projectId,
    sceneId,
    operationId
  })
  if (!execution) throw new Error(`执行记录不存在：${operationId}`)
  return execution
}

async function acceptWaiting(
  fixture: GenerationFixture,
  execution: SceneGenerationExecution,
  replyId: string
): Promise<void> {
  expect(execution.state).toBe('waiting')
  expect(execution.interaction).toBeDefined()
  await fixture.app.generation.replySceneGenerationInteraction({
    ...identityOf(execution),
    interactionId: execution.interaction!.interactionId,
    checkpointId: execution.checkpointId!,
    candidateSnapshotId: execution.candidateSnapshotId!,
    replyId,
    reply: { kind: 'accept' }
  })
  await fixture.run()
}

function clientFor(controller: SceneGenerationController): SceneGenerationClientImpl {
  return new SceneGenerationClientImpl({
    listSceneGenerationHistory: (value: unknown) => controller.listHistory(value, access),
    getSceneGenerationStatus: (value: unknown) => controller.status(value, access),
    getLatestSceneGeneration: (value: unknown) => controller.latest(value, access),
    cancelSceneGeneration: (value: unknown) => controller.cancel(value, access)
  } as unknown as DesktopBridge)
}

it('A 等待→分叉并接受 B→B 终态时 A 仍被发现并阻断；处理后重启 C 不需手动 reload', async () => {
  const f = await generationFixture({
    scriptForWrite: (writes) => (writes === 1 ? validScript : forkScript)
  })
  try {
    await f.app.generation.generateScene({ ...request, reviewCandidate: true })
    await f.run()
    const a = await readExecution(f.app, request.operationId)
    expect(a.state).toBe('waiting')
    expect(a.checkpointId).toBeDefined()
    expect(a.mode).toBe('generate')

    await f.app.generation.forkSceneGeneration({
      ...identityOf(a),
      operationId: 'operation-fork',
      checkpointId: a.checkpointId!,
      policy: request.policy,
      reviewCandidate: true
    })
    await f.run()
    const b = await readExecution(f.app, 'operation-fork')
    expect(b.state).toBe('waiting')
    await acceptWaiting(f, b, 'accept-fork')
    const committedB = await readExecution(f.app, 'operation-fork')
    expect(committedB.state).toBe('succeeded')
    expect(committedB.result?.commitId).toBeTruthy()

    const logger: LoggerGateway = {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined
    }
    const controller = new SceneGenerationController(
      {
        launch: f.app.launch,
        renderQuery: f.app.renderQuery,
        control: f.app.control,
        history: f.app.history,
        preview: f.app.candidatePreview,
        generation: f.app.generation
      } as unknown as SceneGenerationApplicationGateway,
      new IpcExceptionHandler(logger, new IpcErrorMapper())
    )
    const client = clientFor(controller)

    const loaded = await readGenerationHistory(client, projectId, sceneId)
    expect(loaded.kind).toBe('status')
    if (loaded.kind !== 'status') throw new Error('发现读取失败')
    expect(loaded.status.operationId).toBe('operation-fork')
    const discoveredA = unfinishedSelectionOf(loaded.unfinished, a.operationId, {
      projectId,
      sceneId
    })
    expect(discoveredA).toMatchObject({
      operationId: a.operationId,
      checkpointId: a.checkpointId,
      state: 'waiting',
      blocksNewGeneration: true
    })
    // 能选中/查看不等于获得继续或核对资格。
    expect(discoveredA?.canResumeUnfinished).toBeUndefined()
    expect(discoveredA?.canVerifyResult).toBeUndefined()

    const blocking = startBlockingOperationOf(loaded.status, loaded.unfinished)
    expect(blocking).toEqual({
      operationId: a.operationId,
      stageMessage: discoveredA!.stageMessage
    })
    const blockerInput = {
      saveState: 'saved' as const,
      pageBlocked: false,
      canvasReady: true,
      statusCheck: 'ready' as const,
      blockingOperation: blocking,
      unavailableReason: null
    }
    expect(startBlockedReason(blockerInput)).toContain('当前场景已有进行中的生成')
    expect(startBlockedReason(blockerInput)).toContain(discoveredA!.stageMessage)
    expect(startBlockedReason(blockerInput)).toContain('AI 历史')
    // 修复不占生成位置，不被该冲突禁用。
    expect(startBlockedReason(blockerInput, 'repair')).toBeNull()

    // 从发现列表选中并按真实取消入口处理 A；后端返回权威终态。
    expect(
      unfinishedSelectionOf(loaded.unfinished, a.operationId, { projectId, sceneId })
    ).not.toBeNull()
    const cancelled = await controller.cancel(
      { projectId, sceneId, operationId: a.operationId },
      access
    )
    expect(cancelled.code).toBe(ErrorCodes.success)
    expect(cancelled.data?.state).toBe('cancelled')

    const afterCancel = await readGenerationHistory(client, projectId, sceneId)
    expect(afterCancel.kind).toBe('status')
    if (afterCancel.kind !== 'status') throw new Error('发现读取失败')
    expect(afterCancel.unfinished.some((item) => item.operationId === a.operationId)).toBe(false)
    expect(startBlockingOperationOf(afterCancel.status, afterCancel.unfinished)).toBeNull()

    // 不手动 reload：从新的终态视图直接启动 C，并让 C 也走到终态；发现列表不带旧 A。
    const pendingC = await f.app.generation.generateScene({
      ...request,
      operationId: 'operation-c',
      reviewCandidate: true
    })
    await f.run()
    const c = await readExecution(f.app, pendingC.operationId)
    await acceptWaiting(f, c, 'accept-c')
    const committedC = await readExecution(f.app, 'operation-c')
    expect(committedC.state).toBe('succeeded')

    const afterC = await readGenerationHistory(client, projectId, sceneId)
    expect(afterC.kind).toBe('status')
    if (afterC.kind !== 'status') throw new Error('发现读取失败')
    expect(afterC.status.operationId).toBe('operation-c')
    expect(afterC.status.state).toBe('succeeded')
    expect(afterC.unfinished.some((item) => item.operationId === a.operationId)).toBe(false)
    expect(startBlockingOperationOf(afterC.status, afterC.unfinished)).toBeNull()
  } finally {
    await f.app.close?.()
  }
}, 40_000)
