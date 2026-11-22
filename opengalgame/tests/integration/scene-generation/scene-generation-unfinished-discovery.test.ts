/**
 * R1：工作台重开时从真实执行记录发现没有检查点的未完成操作。
 *
 * 使用真实仓储、状态投影和公共 client/controller，不按预知操作 ID 发起发现；
 * 模型由夹具的可控 fetch 提供。只验证代码路径，不启动 Electron 或页面。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

import { createSceneGeneration } from '@bootstrap/sceneGeneration'
import type { SceneGenerationExecution } from '@application/scene-generation/models/SceneGenerationExecution'
import type { SceneGenerationScopeDTO } from '@application/scene-generation/dto/SceneGenerationDTO'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { LoggerGateway } from '@common/logging/LoggerGateway'
import type { DesktopBridge } from '@interfaces/client/DesktopBridge'
import { IpcErrorMapper } from '@interfaces/ipc/errors/IpcErrorMapper'
import { IpcExceptionHandler } from '@interfaces/ipc/errors/IpcExceptionHandler'
import {
  SceneGenerationController,
  type SceneGenerationApplicationGateway
} from '@interfaces/scene-generation/ipc/SceneGenerationController'
import { SceneGenerationClientImpl } from '@interfaces/scene-generation/client/SceneGenerationClientImpl'
import {
  readGenerationHistory,
  unfinishedSelectionOf
} from '@presentation/pages/workbench/drawer/generation/useGenerationStatus'
import {
  generationFixture,
  request,
  type GenerationFixture
} from '../../../../harness/acceptance/support/generationFixture'

const access = { trusted: true, requestId: 'orphan-discovery-test' }

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

type Reopened = {
  app: Awaited<ReturnType<typeof createSceneGeneration>>
  jobs: Array<() => Promise<void>>
  run: () => Promise<void>
}

async function reopen(base: GenerationFixture): Promise<Reopened> {
  const jobs: Array<() => Promise<void>> = []
  const app = await createSceneGeneration({
    ...base.config,
    dispatch: (job: () => Promise<void>) => {
      jobs.push(job)
    },
    publishProgress: () => undefined
  })
  return {
    app,
    jobs,
    run: async () => {
      const job = jobs.shift()
      if (!job) throw new Error('缺少任务')
      await job()
    }
  }
}

function controllerFor(app: Reopened['app']): SceneGenerationController {
  const logger: LoggerGateway = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  }
  return new SceneGenerationController(
    {
      launch: app.launch,
      renderQuery: app.renderQuery,
      control: app.control,
      history: app.history,
      preview: app.candidatePreview,
      generation: app.generation
    } as unknown as SceneGenerationApplicationGateway,
    new IpcExceptionHandler(logger, new IpcErrorMapper())
  )
}

function clientFor(controller: SceneGenerationController): SceneGenerationClientImpl {
  return new SceneGenerationClientImpl({
    listSceneGenerationHistory: (value: unknown) => controller.listHistory(value, access),
    getSceneGenerationStatus: (value: unknown) => controller.status(value, access),
    getLatestSceneGeneration: (value: unknown) => controller.latest(value, access),
    resumeSceneGeneration: (value: unknown) => controller.resume(value, access),
    cancelSceneGeneration: (value: unknown) => controller.cancel(value, access)
  } as unknown as DesktopBridge)
}

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
  app: Reopened['app'],
  scope: SceneGenerationScopeDTO
): Promise<SceneGenerationExecution> {
  const execution = await app.ports.executions.readExecution(scope)
  if (!execution) throw new Error('执行记录不存在')
  return execution
}

async function listOperations(app: Reopened['app']): Promise<readonly SceneGenerationExecution[]> {
  return app.ports.executions.listSceneExecutions({
    projectId: request.projectId,
    sceneId: request.sceneId,
    limit: 100
  })
}

async function generateReviewed(base: GenerationFixture): Promise<SceneGenerationExecution> {
  await base.app.generation.generateScene({ ...request, reviewCandidate: true })
  await base.run()
  return readExecution(base.app, request)
}

function workspaceEntry(
  userStateRoot: string,
  execution: Pick<SceneGenerationExecution, 'projectId' | 'threadId' | 'operationId'>
): string {
  return join(
    userStateRoot,
    'ai',
    'projects',
    execution.projectId,
    'threads',
    execution.threadId,
    'workspaces',
    execution.operationId,
    'game/scene/start.txt'
  )
}

it('[R1] 来源推进后仍能发现并恢复无检查点分叉遗留；查询不写、不调用模型', async () => {
  const base = await generationFixture()
  const source = await generateReviewed(base)
  const forkOperationId = 'operation-fork-orphan'
  await base.app.generation.forkSceneGeneration({
    projectId: request.projectId,
    sceneId: request.sceneId,
    threadId: source.threadId,
    branchId: source.branchId,
    checkpointId: source.checkpointId!,
    operationId: forkOperationId,
    policy: request.policy,
    reviewCandidate: true
  })
  const forkScope = { projectId: request.projectId, sceneId: request.sceneId, operationId: forkOperationId }
  const fork = await readExecution(base.app, forkScope)
  expect(fork.state).toBe('pending')
  expect(fork.checkpointId).toBeUndefined()

  // 来源在分叉崩溃后继续推进，记录时间比遗留分叉更晚；只用 latest 会遮住分叉。
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(Date.now() + 60_000))
  const advancedSource = await base.app.ports.executions.writeExecution({
    ...source,
    sequence: source.sequence + 2
  })
  vi.useRealTimers()
  expect(advancedSource.updatedAt! > fork.updatedAt!).toBe(true)
  base.jobs.length = 0

  const reopened = await reopen(base)
  const before = await listOperations(reopened.app)
  const modelCallsBefore = base.bodies.length
  const client = clientFor(controllerFor(reopened.app))

  const loaded = await readGenerationHistory(client, request.projectId, request.sceneId)
  if (loaded.kind === 'error') throw new Error(loaded.message)
  expect(loaded.kind).toBe('status')
  expect(loaded.kind === 'status' ? loaded.status.operationId : null).toBe(source.operationId)
  const discovered = loaded.unfinished
  const forkStatus = unfinishedSelectionOf(discovered, forkOperationId, {
    projectId: request.projectId,
    sceneId: request.sceneId
  })
  expect(forkStatus?.operationId).toBe(forkOperationId)
  expect(forkStatus?.canResumeUnfinished).toBe(true)
  expect(forkStatus?.checkpointId).toBeUndefined()
  expect(forkStatus?.blocksNewGeneration).toBeUndefined()

  // 发现和读取都是只读：记录、任务队列和模型调用都不变。
  expect(await listOperations(reopened.app)).toEqual(before)
  expect(reopened.jobs).toHaveLength(0)
  expect(base.bodies.length).toBe(modelCallsBefore)

  await expect(client.resumeUnfinished(identityOf(fork))).resolves.toMatchObject({
    code: ErrorCodes.success,
    data: { operationId: forkOperationId, state: 'pending' }
  })
  expect(base.bodies.length).toBe(modelCallsBefore)
  await reopened.run()

  const settled = await readExecution(reopened.app, forkScope)
  expect(settled.state).toBe('waiting')
  expect(settled.checkpointId).toBeDefined()
  expect(base.bodies.length).toBe(modelCallsBefore)
})

it('[R1] 修复输入物化后崩溃同样被发现并可继续，选择本身不写状态', async () => {
  const base = await generationFixture()
  const source = await generateReviewed(base)
  const instruction = '把道别写得更克制'
  await base.app.generation.replySceneGenerationInteraction({
    ...identityOf(source),
    interactionId: source.interaction!.interactionId,
    checkpointId: source.checkpointId!,
    candidateSnapshotId: source.candidateSnapshotId!,
    replyId: 'repair-source-revise',
    reply: { kind: 'revise', body: instruction }
  })
  await base.run()
  const revisedSource = await readExecution(base.app, request)
  await base.app.ports.executions.writeExecution({
    ...revisedSource,
    state: 'failed',
    step: undefined,
    interaction: undefined,
    pendingReply: undefined,
    interruptReason: undefined,
    failure: undefined
  })

  const operationId = 'operation-repair-orphan'
  await base.app.generation.retryFailedRepair({
    projectId: request.projectId,
    sceneId: request.sceneId,
    canvasId: request.inputs.canvasId,
    confirmedControls: [],
    policy: request.policy,
    operationId,
    repair: {
      sourceOperationId: revisedSource.operationId,
      sourceThreadId: revisedSource.threadId,
      sourceBranchId: revisedSource.branchId,
      sourceCheckpointId: revisedSource.checkpointId!,
      candidateSnapshotId: revisedSource.candidateSnapshotId!,
      instruction
    }
  })
  const repairScope = { projectId: request.projectId, sceneId: request.sceneId, operationId }
  const created = await readExecution(base.app, repairScope)
  const materialized = await base.app.ports.workspace.materializeRepairInput(
    created,
    created.repairSource!
  )
  const running = await base.app.ports.executions.writeExecution({
    ...created,
    state: 'running',
    step: 'preparing',
    repairInputSnapshotId: materialized.candidateSnapshotId,
    workspace: {
      workspaceId: materialized.workspaceId,
      rootDirectory: materialized.rootDirectory,
      sceneDirectory: materialized.sceneDirectory
    },
    sequence: created.sequence + 1
  })
  base.jobs.length = 0
  const entryBefore = await readFile(workspaceEntry(base.config.userStateRoot, running), 'utf8')

  const reopened = await reopen(base)
  const before = await listOperations(reopened.app)
  const modelCallsBefore = base.bodies.length
  const client = clientFor(controllerFor(reopened.app))
  const loaded = await readGenerationHistory(client, request.projectId, request.sceneId)
  if (loaded.kind === 'error') throw new Error(loaded.message)
  const repairStatus = unfinishedSelectionOf(loaded.unfinished, operationId, {
    projectId: request.projectId,
    sceneId: request.sceneId
  })
  expect(repairStatus?.operationId).toBe(operationId)
  expect(repairStatus?.canResumeUnfinished).toBe(true)
  expect(repairStatus?.blocksNewGeneration).toBeUndefined()
  expect(await listOperations(reopened.app)).toEqual(before)
  expect(reopened.jobs).toHaveLength(0)
  expect(base.bodies.length).toBe(modelCallsBefore)

  await expect(client.resumeUnfinished(identityOf(running))).resolves.toMatchObject({
    code: ErrorCodes.success,
    data: { operationId, state: 'pending' }
  })
  expect(base.bodies.length).toBe(modelCallsBefore)
  await reopened.run()
  const settled = await readExecution(reopened.app, repairScope)
  expect(settled.state).toBe('waiting')
  expect(settled.checkpointId).toBeDefined()
  expect(settled.repairInputSnapshotId).toBe(materialized.candidateSnapshotId)
  expect(await readFile(workspaceEntry(base.config.userStateRoot, settled), 'utf8')).toBe(entryBefore)
})

it('[R1] 仍由本进程运行的生成不会被伪装成可恢复遗留', async () => {
  const base = await generationFixture()
  await base.app.generation.generateScene({ ...request, reviewCandidate: true })
  const client = clientFor(controllerFor(base.app))

  const loaded = await readGenerationHistory(client, request.projectId, request.sceneId)
  if (loaded.kind === 'error') throw new Error(loaded.message)
  expect(loaded.kind).toBe('status')
  expect(loaded.kind === 'status' ? loaded.status.canResumeUnfinished : undefined).toBeUndefined()
  const active = loaded.unfinished.find((item) => item.operationId === loaded.status.operationId)
  expect(active?.canResumeUnfinished).toBeUndefined()
  expect(active?.canVerifyResult).toBeUndefined()
  expect(active?.blocksNewGeneration).toBe(true)
  expect(base.jobs).toHaveLength(1)
  base.jobs.length = 0
})
