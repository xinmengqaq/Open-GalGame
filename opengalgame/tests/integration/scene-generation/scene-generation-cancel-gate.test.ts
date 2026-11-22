/**
 * 取消与提交门的普通集成回归。
 *
 * 使用真实 createSceneGeneration、SceneGenerationController 和
 * SceneGenerationClientImpl；模型响应是脚本替身，正式工程、Git 与版本端口是真实实现。
 * 版本端口只增加栅栏或错误注入，不改提交规则。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { DesktopBridge } from '@interfaces/client/DesktopBridge'
import type { LoggerGateway } from '@common/logging/LoggerGateway'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { SceneGenerationClientImpl } from '@interfaces/scene-generation/client/SceneGenerationClientImpl'
import {
  SceneGenerationController,
  type SceneGenerationApplicationGateway
} from '@interfaces/scene-generation/ipc/SceneGenerationController'
import { IpcErrorMapper } from '@interfaces/ipc/errors/IpcErrorMapper'
import { IpcExceptionHandler } from '@interfaces/ipc/errors/IpcExceptionHandler'
import {
  generationFixture,
  request,
  type GenerationFixture
} from '../../../../harness/acceptance/support/generationFixture'

const entryPath = 'game/scene/start.txt'
const access = { trusted: true, requestId: 'cancel-gate-integration' }

const logger: LoggerGateway = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
}

/**
 * 把真实 controller 接到真实 client。装配夹具不提供渲染依赖，只调用取消通道；
 * 启动、回复和最终状态仍走真实应用服务，避免为测试补造影子执行器。
 */
function clientOf(base: GenerationFixture): SceneGenerationClientImpl {
  const controller = new SceneGenerationController(
    {
      launch: base.app.launch,
      renderQuery: base.app.renderQuery,
      control: base.app.control,
      history: base.app.history,
      preview: base.app.candidatePreview,
      generation: base.app.generation
    } as unknown as SceneGenerationApplicationGateway,
    new IpcExceptionHandler(logger, new IpcErrorMapper())
  )
  const bridge = {
    cancelSceneGeneration: (input: unknown) => controller.cancel(input, access)
  } as unknown as DesktopBridge
  return new SceneGenerationClientImpl(bridge)
}

async function officialFacts(base: GenerationFixture): Promise<{
  entry: string
  head: string
  commits: number
}> {
  return {
    entry: await readFile(join(base.projectRoot, entryPath), 'utf8'),
    head: base.git('rev-parse', 'HEAD'),
    commits: Number(base.git('rev-list', '--count', 'HEAD'))
  }
}

it('取消先于提交门：在途取消被受理，正式作品与提交数不变', async () => {
  const base = await generationFixture()
  const official = await officialFacts(base)
  const client = clientOf(base)

  const inspectionEntered = Promise.withResolvers<void>()
  const releaseInspection = Promise.withResolvers<void>()
  let blocked = false
  const originalInspect = base.app.ports.versions.inspectBaseline.bind(
    base.app.ports.versions
  )
  vi.spyOn(base.app.ports.versions, 'inspectBaseline').mockImplementation(async (execution) => {
    const facts = await originalInspect(execution)
    if (!blocked && execution.candidateSnapshotId !== undefined) {
      blocked = true
      inspectionEntered.resolve()
      await releaseInspection.promise
    }
    return facts
  })

  const started = await base.app.generation.generateScene(request)
  const scope = {
    projectId: started.projectId,
    sceneId: started.sceneId,
    operationId: started.operationId
  }
  const running = base.run()
  await inspectionEntered.promise

  const cancelled = await client.cancel(scope)
  expect(cancelled).toMatchObject({
    code: ErrorCodes.success,
    msg: '取消已受理，正在结束本次生成',
    data: { state: 'cancelling' }
  })
  expect(await officialFacts(base)).toEqual(official)

  releaseInspection.resolve()
  await running

  const final = await base.app.status.getSceneGenerationStatus(scope)
  expect(final).toMatchObject({
    state: 'cancelled',
    canResume: false
  })
  const execution = await base.app.ports.executions.readExecution(scope)
  expect(execution?.state).toBe('cancelled')
  expect(execution?.cancellationRequested).toBe(true)
  expect(execution?.interaction).toBeUndefined()
  expect(execution?.pendingReply).toBeUndefined()
  expect(execution?.replies).toEqual([])
  expect(await officialFacts(base)).toEqual(official)
}, 30000)

it('取消晚于提交门：明确拒绝，提交继续一次并保持已提交', async () => {
  const base = await generationFixture()
  const official = await officialFacts(base)
  const client = clientOf(base)
  const started = await base.app.generation.generateScene({
    ...request,
    reviewCandidate: true
  })
  const scope = {
    projectId: started.projectId,
    sceneId: started.sceneId,
    operationId: started.operationId
  }
  await base.run()
  const waiting = await base.app.status.getSceneGenerationStatus(scope)
  expect(waiting.state).toBe('waiting')
  const interaction = waiting.interaction
  expect(interaction).toBeTruthy()

  const prepareEntered = Promise.withResolvers<void>()
  const releasePrepare = Promise.withResolvers<void>()
  const basePrepare = base.config.versioning.prepareOperation.bind(base.config.versioning)
  base.config.versioning.prepareOperation = async (input) => {
    prepareEntered.resolve()
    await releasePrepare.promise
    return basePrepare(input)
  }

  await base.app.generation.replySceneGenerationInteraction({
    projectId: waiting.projectId,
    sceneId: waiting.sceneId,
    operationId: waiting.operationId,
    threadId: waiting.threadId,
    branchId: waiting.branchId,
    interactionId: interaction!.interactionId,
    checkpointId: interaction!.checkpointId,
    ...(interaction!.candidateSnapshotId
      ? { candidateSnapshotId: interaction!.candidateSnapshotId }
      : {}),
    replyId: 'accept-before-cancel',
    reply: { kind: 'accept' }
  })
  const running = base.run()
  await prepareEntered.promise
  expect((await base.app.status.getSceneGenerationStatus(scope)).state).toBe('committing')

  const refused = await client.cancel(scope)
  expect(refused).toMatchObject({
    code: 4103,
    msg: '正在提交作品，不能取消'
  })
  expect((await base.app.ports.executions.readExecution(scope))?.state).toBe('committing')

  releasePrepare.resolve()
  await running
  const committed = await base.app.status.getSceneGenerationStatus(scope)
  expect(committed).toMatchObject({ state: 'succeeded' })
  expect(committed.result?.commitId).toBeTruthy()
  const afterCommit = await officialFacts(base)
  expect(afterCommit.entry).not.toBe(official.entry)
  expect(afterCommit.commits).toBe(official.commits + 1)
  expect((await base.app.ports.executions.readExecution(scope))?.cancellationRequested).toBeUndefined()

  const late = await client.cancel(scope)
  expect(late).toMatchObject({ code: 4103, msg: '作品已提交，不能取消' })
  expect(await officialFacts(base)).toEqual(afterCommit)
  expect((await base.app.status.getSceneGenerationStatus(scope)).state).toBe('succeeded')
}, 30000)

it('取消晚于提交门时提交端口失败：原提交错误保留，取消不掩盖', async () => {
  const base = await generationFixture()
  const official = await officialFacts(base)
  const client = clientOf(base)
  const started = await base.app.generation.generateScene({ ...request, reviewCandidate: true })
  const scope = {
    projectId: started.projectId,
    sceneId: started.sceneId,
    operationId: started.operationId
  }
  await base.run()
  const waiting = await base.app.status.getSceneGenerationStatus(scope)
  const interaction = waiting.interaction
  expect(interaction).toBeTruthy()

  const prepareEntered = Promise.withResolvers<void>()
  const failPrepare = Promise.withResolvers<void>()
  base.config.versioning.prepareOperation = async () => {
    prepareEntered.resolve()
    await failPrepare.promise
    throw new AppException({ code: ErrorCodes.internalError, msg: '版本端口提交失败' })
  }

  await base.app.generation.replySceneGenerationInteraction({
    projectId: waiting.projectId,
    sceneId: waiting.sceneId,
    operationId: waiting.operationId,
    threadId: waiting.threadId,
    branchId: waiting.branchId,
    interactionId: interaction!.interactionId,
    checkpointId: interaction!.checkpointId,
    ...(interaction!.candidateSnapshotId
      ? { candidateSnapshotId: interaction!.candidateSnapshotId }
      : {}),
    replyId: 'accept-before-cancel-failure',
    reply: { kind: 'accept' }
  })
  const running = base.run()
  await prepareEntered.promise
  expect((await client.cancel(scope)).code).toBe(4103)

  failPrepare.resolve()
  await expect(running).rejects.toMatchObject({
    code: ErrorCodes.internalError,
    message: '版本端口提交失败'
  })

  const execution = await base.app.ports.executions.readExecution(scope)
  expect(execution?.state).toBe('failed')
  expect(execution?.cancellationRequested).not.toBe(true)
  expect(execution?.failure?.message).toBe('版本端口提交失败')
  expect(await officialFacts(base)).toEqual(official)
  const failed = await base.app.status.getSceneGenerationStatus(scope)
  expect(failed).toMatchObject({ state: 'failed' })
}, 30000)
