/**
 * 包 A：无检查点崩溃现场的公共恢复入口与待核对取消边界。
 *
 * 只用真实装配、真实候选工作区/修订/账本和公开 controller/client 入口；
 * 模型由可控 fetch 提供。测试不启动 Electron 或页面，也不重跑冻结验收。
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

import { createSceneGeneration, type SceneGenerationServices } from '@bootstrap/sceneGeneration'
import type { SceneGenerationScopeDTO } from '@application/scene-generation/dto/SceneGenerationDTO'
import type { SceneGenerationExecution } from '@application/scene-generation/models/SceneGenerationExecution'
import { toRenderStatusVO } from '@application/scene-generation/mapping/SceneGenerationRenderProjection'
import { SceneGenerationWriteOutcomeUnknown } from '@application/scene-generation/errors/SceneGenerationWriteOutcomeUnknown'
import { safeFailureWithDiagnosticRef } from '@application/scene-generation/services/impl/SceneGenerationFailureFacts'
import { AiProjectFileSystemImpl } from '@infrastructure/ai/filesystem/AiProjectFileSystemImpl'
import type { LoggerGateway } from '@common/logging/LoggerGateway'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { DesktopBridge } from '@interfaces/client/DesktopBridge'
import { IpcErrorMapper } from '@interfaces/ipc/errors/IpcErrorMapper'
import { IpcExceptionHandler } from '@interfaces/ipc/errors/IpcExceptionHandler'
import {
  SceneGenerationController,
  type SceneGenerationApplicationGateway
} from '@interfaces/scene-generation/ipc/SceneGenerationController'
import { SceneGenerationClientImpl } from '@interfaces/scene-generation/client/SceneGenerationClientImpl'
import {
  generationFixture,
  request,
  validScript,
  type GenerationFixture
} from '../../../../harness/acceptance/support/generationFixture'

const access = { trusted: true, requestId: 'recovery-entry-test' }

afterEach(() => {
  vi.restoreAllMocks()
})

type Reopened = {
  app: SceneGenerationServices
  jobs: Array<() => Promise<void>>
  run: () => Promise<void>
}

async function reopen(
  base: GenerationFixture,
  fetcher?: typeof fetch
): Promise<Reopened> {
  const jobs: Array<() => Promise<void>> = []
  const app = await createSceneGeneration({
    ...base.config,
    ...(fetcher === undefined ? {} : { fetcher }),
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

function logger(): LoggerGateway {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  }
}

function controllerFor(app: SceneGenerationServices): SceneGenerationController {
  return new SceneGenerationController(
    {
      launch: app.launch,
      renderQuery: app.renderQuery,
      control: app.control,
      history: app.history,
      preview: app.candidatePreview,
      generation: app.generation
    } as unknown as SceneGenerationApplicationGateway,
    new IpcExceptionHandler(logger(), new IpcErrorMapper())
  )
}

function clientFor(controller: SceneGenerationController): SceneGenerationClientImpl {
  return new SceneGenerationClientImpl({
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
  app: SceneGenerationServices,
  scope: SceneGenerationScopeDTO
): Promise<SceneGenerationExecution> {
  const execution = await app.ports.executions.readExecution(scope)
  if (!execution) throw new Error('执行记录不存在')
  return execution
}

function workspaceRoot(
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
    execution.operationId
  )
}

function workspaceEntry(
  userStateRoot: string,
  execution: Pick<SceneGenerationExecution, 'projectId' | 'threadId' | 'operationId'>
): string {
  return join(workspaceRoot(userStateRoot, execution), 'game/scene/start.txt')
}

async function officialFacts(base: GenerationFixture): Promise<{
  entry: string
  head: string
  commits: number
}> {
  return {
    entry: await readFile(join(base.projectRoot, 'game/scene/start.txt'), 'utf8'),
    head: base.git('rev-parse', 'HEAD'),
    commits: Number(base.git('rev-list', '--count', 'HEAD'))
  }
}

async function listOperations(
  app: SceneGenerationServices
): Promise<readonly SceneGenerationExecution[]> {
  return app.ports.executions.listSceneExecutions({
    projectId: request.projectId,
    sceneId: request.sceneId,
    limit: 100
  })
}

async function effectsSnapshot(
  userStateRoot: string,
  execution: Pick<SceneGenerationExecution, 'projectId' | 'threadId' | 'operationId'>
): Promise<string> {
  const directory = join(
    userStateRoot,
    'ai',
    'projects',
    execution.projectId,
    'threads',
    execution.threadId,
    'operations',
    execution.operationId,
    'effects'
  )
  const names = (await readdir(directory).catch(() => [])).filter((name) =>
    name.endsWith('.json')
  )
  const values = await Promise.all(
    names.sort().map(async (name) => `${name}:${await readFile(join(directory, name), 'utf8')}`)
  )
  return values.join('\n')
}

async function generateReviewed(base: GenerationFixture): Promise<SceneGenerationExecution> {
  await base.app.generation.generateScene({ ...request, reviewCandidate: true })
  await base.run()
  return readExecution(base.app, request)
}

it('[B1] 修复输入物化后首写前崩溃：公开入口按原工作区复用输入，不把输入当候选', async () => {
  const base = await generationFixture()
  const official = await officialFacts(base)
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

  const operationId = 'operation-repair-entry'
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
  const scope = { projectId: request.projectId, sceneId: request.sceneId, operationId }
  const createdExecution = await readExecution(base.app, scope)
  const materialized = await base.app.ports.workspace.materializeRepairInput(
    createdExecution,
    createdExecution.repairSource!
  )
  const running = await base.app.ports.executions.writeExecution({
    ...createdExecution,
    state: 'running',
    step: 'preparing',
    repairInputSnapshotId: materialized.candidateSnapshotId,
    workspace: {
      workspaceId: materialized.workspaceId,
      rootDirectory: materialized.rootDirectory,
      sceneDirectory: materialized.sceneDirectory
    },
    sequence: createdExecution.sequence + 1
  })
  base.jobs.length = 0
  expect(running.workspace?.rootDirectory).toBe(materialized.rootDirectory)
  expect(running.candidateSnapshotId).toBeUndefined()
  expect(running.repairInputSnapshotId).not.toBe(revisedSource.candidateSnapshotId)
  const beforeEntry = await readFile(workspaceEntry(base.config.userStateRoot, running), 'utf8')
  expect(beforeEntry).toBe(validScript)
  const operationsBefore = (await listOperations(base.app)).length

  const reopened = await reopen(base)
  const prove = vi.spyOn(reopened.app.ports.workspace, 'proveRepairInput')
  const materialize = vi.spyOn(reopened.app.ports.workspace, 'materializeRepairInput')
  const createWorkspace = vi.spyOn(reopened.app.ports.workspace, 'createWorkspace')
  const discardWorkspace = vi.spyOn(reopened.app.ports.workspace, 'discardWorkspace')
  const modelCallsBefore = base.bodies.length
  const beforeRead = await readExecution(reopened.app, scope)
  const client = clientFor(controllerFor(reopened.app))

  // 普通读取只返回持久状态，不写记录、不排队模型。
  await expect(reopened.app.status.getSceneGenerationStatus(scope)).resolves.toMatchObject({
    state: 'running'
  })
  expect(await readExecution(reopened.app, scope)).toEqual(beforeRead)
  expect(reopened.jobs).toHaveLength(0)
  expect(base.bodies.length).toBe(modelCallsBefore)

  await expect(client.resumeUnfinished(identityOf(running))).resolves.toMatchObject({
    code: ErrorCodes.success,
    data: { operationId, state: 'pending' }
  })
  const resumed = await readExecution(reopened.app, scope)
  expect(resumed.state).toBe('pending')
  expect(resumed.attempt).toBe(running.attempt + 1)
  expect(resumed.candidateSnapshotId).toBeUndefined()
  expect(resumed.repairInputSnapshotId).toBe(materialized.candidateSnapshotId)
  expect(await readFile(workspaceEntry(base.config.userStateRoot, resumed), 'utf8')).toBe(
    beforeEntry
  )
  expect(base.bodies.length).toBe(modelCallsBefore)
  expect(reopened.jobs).toHaveLength(1)
  expect(prove).not.toHaveBeenCalled()
  expect(materialize).not.toHaveBeenCalled()
  expect(createWorkspace).not.toHaveBeenCalled()
  expect(discardWorkspace).not.toHaveBeenCalled()

  await reopened.run()
  const settled = await readExecution(reopened.app, scope)
  expect(settled.state).toBe('waiting')
  expect(settled.interaction?.kind).toBe('review')
  expect(settled.candidateSnapshotId).toBeDefined()
  expect(settled.candidateSnapshotId).not.toBe(settled.repairInputSnapshotId)
  expect(settled.checkpointId).toBeDefined()
  expect(settled.repairInputSnapshotId).toBe(materialized.candidateSnapshotId)
  expect(base.bodies.length).toBeGreaterThan(modelCallsBefore)
  expect(await readFile(workspaceEntry(base.config.userStateRoot, settled), 'utf8')).toBe(validScript)
  expect(prove).toHaveBeenCalled()
  expect(materialize).not.toHaveBeenCalled()
  expect(createWorkspace).not.toHaveBeenCalled()
  expect(discardWorkspace).not.toHaveBeenCalled()
  expect((await listOperations(reopened.app)).length).toBe(operationsBefore)
  expect((await readExecution(reopened.app, request)).state).toBe('failed')
  expect(await officialFacts(base)).toEqual(official)
})

it('[B1] 分叉首写前无检查点崩溃：公开入口从来源候选继续，不调用模型', async () => {
  const base = await generationFixture()
  const official = await officialFacts(base)
  const source = await generateReviewed(base)
  await base.app.generation.forkSceneGeneration({
    projectId: request.projectId,
    sceneId: request.sceneId,
    threadId: source.threadId,
    branchId: source.branchId,
    checkpointId: source.checkpointId!,
    operationId: 'operation-fork-before-write',
    policy: request.policy,
    reviewCandidate: true
  })
  const scope = {
    projectId: request.projectId,
    sceneId: request.sceneId,
    operationId: 'operation-fork-before-write'
  }
  const fork = await readExecution(base.app, scope)
  expect(fork.state).toBe('pending')
  expect(fork.checkpointId).toBeUndefined()
  expect(fork.forkRequest).toBeDefined()
  const workspace = await base.app.ports.workspace.restoreWorkspace(
    fork,
    fork.candidateSnapshotId
  )
  const running = await base.app.ports.executions.writeExecution({
    ...fork,
    state: 'running',
    step: 'preparing',
    workspace: {
      workspaceId: workspace.workspaceId,
      rootDirectory: workspace.rootDirectory,
      sceneDirectory: workspace.sceneDirectory
    },
    sequence: fork.sequence + 1
  })
  base.jobs.length = 0
  const beforeEntry = await readFile(workspaceEntry(base.config.userStateRoot, running), 'utf8')

  const reopened = await reopen(base)
  const modelCallsBefore = base.bodies.length
  const client = clientFor(controllerFor(reopened.app))
  await expect(client.resumeUnfinished(identityOf(running))).resolves.toMatchObject({
    code: ErrorCodes.success,
    data: { operationId: scope.operationId, state: 'pending' }
  })
  expect(base.bodies.length).toBe(modelCallsBefore)
  await reopened.run()

  const settled = await readExecution(reopened.app, scope)
  expect(settled.state).toBe('waiting')
  expect(settled.interaction?.kind).toBe('review')
  expect(settled.checkpointId).toBeDefined()
  expect(settled.forkRequest).toBeUndefined()
  expect(settled.fork?.candidateSnapshotId).toBe(source.candidateSnapshotId)
  expect(settled.candidateSnapshotId).toBe(source.candidateSnapshotId)
  expect(await readFile(workspaceEntry(base.config.userStateRoot, settled), 'utf8')).toBe(
    beforeEntry
  )
  expect(base.bodies.length).toBe(modelCallsBefore)
  expect((await readExecution(reopened.app, request)).state).toBe('waiting')
  expect(await officialFacts(base)).toEqual(official)
})

it('[B1] 分叉首写已落盘但无检查点：公开入口从实际字节继续，不再调用模型', async () => {
  const base = await generationFixture()
  const official = await officialFacts(base)
  const source = await generateReviewed(base)
  await base.app.generation.forkSceneGeneration({
    projectId: request.projectId,
    sceneId: request.sceneId,
    threadId: source.threadId,
    branchId: source.branchId,
    checkpointId: source.checkpointId!,
    operationId: 'operation-fork-after-write',
    policy: request.policy,
    reviewCandidate: true
  })
  const scope = {
    projectId: request.projectId,
    sceneId: request.sceneId,
    operationId: 'operation-fork-after-write'
  }
  const fork = await readExecution(base.app, scope)
  expect(fork.state).toBe('pending')
  const restored = await base.app.ports.workspace.restoreWorkspace(
    fork,
    fork.candidateSnapshotId
  )
  const files = new AiProjectFileSystemImpl(base.config.userStateRoot)
  const workspace = files.locateWorkspace(fork)
  const written = validScript.replace('我们明天见', '我们改天再见')
  await files.writeFile(workspace, 'game/scene/start.txt', Buffer.from(written, 'utf8'))
  const { revisionId } = await files.saveRevision(workspace)
  const running = await base.app.ports.executions.writeExecution({
    ...fork,
    state: 'running',
    step: 'preparing',
    candidateSnapshotId: revisionId,
    workspace: {
      workspaceId: restored.workspaceId,
      rootDirectory: restored.rootDirectory,
      sceneDirectory: restored.sceneDirectory
    },
    sequence: fork.sequence + 1
  })
  base.jobs.length = 0
  expect(running.candidateSnapshotId).toBe(revisionId)
  expect(running.fork?.candidateSnapshotId).toBe(source.candidateSnapshotId)
  expect(await readFile(workspaceEntry(base.config.userStateRoot, running), 'utf8')).toBe(written)

  const reopened = await reopen(base)
  const modelCallsBefore = base.bodies.length
  const client = clientFor(controllerFor(reopened.app))
  await expect(client.resumeUnfinished(identityOf(running))).resolves.toMatchObject({
    code: ErrorCodes.success,
    data: { operationId: scope.operationId, state: 'pending' }
  })
  expect(base.bodies.length).toBe(modelCallsBefore)
  await reopened.run()

  const settled = await readExecution(reopened.app, scope)
  expect(settled.state).toBe('waiting')
  expect(settled.interaction?.kind).toBe('review')
  expect(settled.candidateSnapshotId).toBeDefined()
  expect(settled.checkpointId).toBeDefined()
  expect(settled.fork?.candidateSnapshotId).toBe(source.candidateSnapshotId)
  expect(await readFile(workspaceEntry(base.config.userStateRoot, settled), 'utf8')).toBe(written)
  expect(base.bodies.length).toBe(modelCallsBefore)
  expect((await readExecution(reopened.app, request)).state).toBe('waiting')
  expect(await officialFacts(base)).toEqual(official)
})

it('[B1] 伪造、过时与已有检查点的请求被拒绝，不写记录也不调用模型', async () => {
  const base = await generationFixture()
  const source = await generateReviewed(base)
  const controller = controllerFor(base.app)
  const client = new SceneGenerationClientImpl({
    resumeSceneGeneration: (value: unknown) => controller.resume(value, access)
  } as unknown as DesktopBridge)
  const identity = identityOf(source)
  const operationsBefore = (await listOperations(base.app)).length
  const modelCallsBefore = base.bodies.length

  await expect(
    client.resumeUnfinished({ ...identity, threadId: 'forged-thread' })
  ).resolves.toMatchObject({ code: ErrorCodes.operationConflict })
  await expect(
    client.resumeUnfinished({ ...identity, branchId: 'forged-branch' })
  ).resolves.toMatchObject({ code: ErrorCodes.operationConflict })
  await expect(client.resumeUnfinished(identity)).resolves.toMatchObject({
    code: ErrorCodes.operationConflict,
    msg: expect.stringContaining('检查点')
  })
  await expect(
    controller.resume(
      { ...identity, recovery: 'unfinished', checkpointId: 'forged-checkpoint' },
      access
    )
  ).resolves.toMatchObject({ code: ErrorCodes.invalidRequest })
  expect(base.jobs).toHaveLength(0)
  expect(base.bodies.length).toBe(modelCallsBefore)
  expect((await listOperations(base.app)).length).toBe(operationsBefore)
  const unchanged = await readExecution(base.app, identity)
  expect(unchanged).toEqual(source)

  const paused = await base.app.ports.executions.writeExecution({
    ...source,
    state: 'interrupted',
    interruptReason: 'paused',
    step: undefined,
    interaction: undefined,
    pendingReply: undefined,
    sequence: source.sequence + 1
  })
  await expect(
    client.resume({ ...identity, checkpointId: 'old-checkpoint' })
  ).resolves.toMatchObject({ code: ErrorCodes.operationConflict })
  expect(base.jobs).toHaveLength(0)
  expect(base.bodies.length).toBe(modelCallsBefore)
  expect((await readExecution(base.app, identity)).checkpointId).toBe(paused.checkpointId)
})

it('[B3] 写入待核对现场拒绝普通取消和自动清理，实际文件与账本保持不变', async () => {
  const base = await generationFixture()
  const official = await officialFacts(base)
  const waiting = await generateReviewed(base)
  const writeUnknown = await base.app.ports.executions.writeExecution({
    ...waiting,
    state: 'interrupted',
    step: undefined,
    interaction: undefined,
    pendingReply: undefined,
    interruptReason: 'writeUnknown',
    failure: safeFailureWithDiagnosticRef(
      new SceneGenerationWriteOutcomeUnknown('候选写入回执不明')
    ),
    requiresCleanup: false,
    cancellationRequested: false,
    sequence: waiting.sequence + 1
  })
  const entryBefore = await readFile(workspaceEntry(base.config.userStateRoot, writeUnknown), 'utf8')
  const effectsBefore = await effectsSnapshot(base.config.userStateRoot, writeUnknown)
  const candidateBefore = await base.app.ports.artifacts.readCandidate(
    writeUnknown,
    writeUnknown.candidateSnapshotId!
  )
  const projected = toRenderStatusVO(
    writeUnknown,
    false,
    { resume: true, pause: true },
    false
  )
  expect(projected.canCancel).toBe(false)
  expect(projected.canResume).toBe(false)
  expect(projected.stageMessage).toContain('待核对')
  expect(projected.previewAuthorization).toBe('readOnly')

  const discard = vi.spyOn(base.app.ports.workspace, 'discardWorkspace')
  const cancelScope = {
    projectId: writeUnknown.projectId,
    sceneId: writeUnknown.sceneId,
    operationId: writeUnknown.operationId
  }
  const client = clientFor(controllerFor(base.app))
  await expect(client.cancel(cancelScope)).resolves.toMatchObject({
    code: ErrorCodes.operationConflict,
    msg: expect.stringContaining('待核对')
  })
  await expect(base.app.generation.cancelSceneGeneration(cancelScope)).rejects.toMatchObject({
    code: ErrorCodes.operationConflict
  })
  expect(discard).not.toHaveBeenCalled()
  const afterCancel = await readExecution(base.app, identityOf(writeUnknown))
  expect(afterCancel).toEqual(writeUnknown)
  expect(await readFile(workspaceEntry(base.config.userStateRoot, writeUnknown), 'utf8')).toBe(
    entryBefore
  )
  expect(await effectsSnapshot(base.config.userStateRoot, writeUnknown)).toBe(effectsBefore)
  expect((await stat(workspaceRoot(base.config.userStateRoot, writeUnknown))).isDirectory()).toBe(
    true
  )

  const legacyCancellation = await base.app.ports.executions.writeExecution({
    ...writeUnknown,
    cancellationRequested: true,
    requiresCleanup: true,
    sequence: writeUnknown.sequence + 1
  })
  await expect(base.app.recovery.recoverCancelledProject(request.projectId)).resolves.toEqual({
    attempted: 0,
    failed: 0
  })
  expect(discard).not.toHaveBeenCalled()
  const afterAuto = await readExecution(base.app, identityOf(legacyCancellation))
  expect(afterAuto.interruptReason).toBe('writeUnknown')
  expect(afterAuto.cancellationRequested).toBe(true)
  expect(afterAuto.requiresCleanup).toBe(true)
  expect(await readFile(workspaceEntry(base.config.userStateRoot, afterAuto), 'utf8')).toBe(
    entryBefore
  )
  expect(await effectsSnapshot(base.config.userStateRoot, afterAuto)).toBe(effectsBefore)
  expect(await base.app.ports.artifacts.readCandidate(afterAuto, afterAuto.candidateSnapshotId!)).toEqual(
    candidateBefore
  )
  expect(await officialFacts(base)).toEqual(official)
})

it('[B3] 提交待核对现场同样拒绝普通取消与自动清理，保留工作区字节', async () => {
  const base = await generationFixture()
  const official = await officialFacts(base)
  const waiting = await generateReviewed(base)
  const commitUnknown = await base.app.ports.executions.writeExecution({
    ...waiting,
    state: 'interrupted',
    step: undefined,
    interaction: undefined,
    pendingReply: undefined,
    interruptReason: 'commitUnknown',
    failure: safeFailureWithDiagnosticRef(new Error('formal commit acknowledgement lost')),
    requiresCleanup: true,
    cancellationRequested: false,
    sequence: waiting.sequence + 1
  })
  const entryBefore = await readFile(
    workspaceEntry(base.config.userStateRoot, commitUnknown),
    'utf8'
  )
  const effectsBefore = await effectsSnapshot(base.config.userStateRoot, commitUnknown)
  const projected = toRenderStatusVO(commitUnknown, false, { resume: true, pause: true }, false)
  expect(projected.canCancel).toBe(false)
  expect(projected.canResume).toBe(false)
  expect(projected.stageMessage).toContain('待核对')

  const discard = vi.spyOn(base.app.ports.workspace, 'discardWorkspace')
  const client = clientFor(controllerFor(base.app))
  const scope = {
    projectId: commitUnknown.projectId,
    sceneId: commitUnknown.sceneId,
    operationId: commitUnknown.operationId
  }
  await expect(client.cancel(scope)).resolves.toMatchObject({
    code: ErrorCodes.operationConflict,
    msg: expect.stringContaining('待核对')
  })
  expect(discard).not.toHaveBeenCalled()
  expect(await readExecution(base.app, scope)).toEqual(commitUnknown)
  expect(await readFile(workspaceEntry(base.config.userStateRoot, commitUnknown), 'utf8')).toBe(
    entryBefore
  )
  expect(await effectsSnapshot(base.config.userStateRoot, commitUnknown)).toBe(effectsBefore)

  const legacyCancellation = await base.app.ports.executions.writeExecution({
    ...commitUnknown,
    cancellationRequested: true,
    sequence: commitUnknown.sequence + 1
  })
  await expect(base.app.recovery.recoverCancelledProject(request.projectId)).resolves.toEqual({
    attempted: 0,
    failed: 0
  })
  expect(discard).not.toHaveBeenCalled()
  const afterAuto = await readExecution(base.app, identityOf(legacyCancellation))
  expect(afterAuto.interruptReason).toBe('commitUnknown')
  expect(afterAuto.requiresCleanup).toBe(true)
  expect(await readFile(workspaceEntry(base.config.userStateRoot, afterAuto), 'utf8')).toBe(
    entryBefore
  )
  expect(await officialFacts(base)).toEqual(official)
})

it('[B1/B2] 分叉自己的 reading 检查点在来源前进后从正确检查点恢复，不送来源恢复', async () => {
  const base = await generationFixture()
  const official = await officialFacts(base)
  const source = await generateReviewed(base)
  const sourceCheckpoint = source.checkpointId!
  const sourceCandidate = source.candidateSnapshotId!
  const forkScope = {
    projectId: request.projectId,
    sceneId: request.sceneId,
    operationId: 'operation-fork-reading-boundary'
  }
  await base.app.generation.forkSceneGeneration({
    projectId: request.projectId,
    sceneId: request.sceneId,
    threadId: source.threadId,
    branchId: source.branchId,
    checkpointId: sourceCheckpoint,
    operationId: forkScope.operationId,
    policy: request.policy,
    reviewCandidate: true,
    decisionChanges: [
      {
        interactionId: source.interaction!.interactionId,
        reply: { kind: 'revise', body: '改成各自回家' }
      }
    ]
  })

  const originalRead = base.app.ports.artifacts.readCandidate.bind(base.app.ports.artifacts)
  let reads = 0
  const readSpy = vi
    .spyOn(base.app.ports.artifacts, 'readCandidate')
    .mockImplementation(async (...args) => {
      reads += 1
      // 第 1 次读来源候选；第 2 次是修复循环的起点；第 3 次是分叉写出后的 reading 读回。
      if (reads === 3) throw new Error('candidate read interrupted after fork write')
      return originalRead(...args)
    })
  await base.run().catch(() => undefined)
  readSpy.mockRestore()

  const interrupted = await readExecution(base.app, forkScope)
  expect(interrupted.state).toBe('interrupted')
  expect(interrupted.interruptReason).toBe('readInterrupted')
  expect(interrupted.step).toBe('reading')
  expect(interrupted.checkpointId).toBeDefined()
  expect(interrupted.checkpointId).not.toBe(sourceCheckpoint)
  expect(interrupted.candidateSnapshotId).toBeDefined()
  expect(interrupted.candidateSnapshotId).not.toBe(sourceCandidate)
  expect(interrupted.forkRequest).toBeDefined()
  expect(interrupted.fork?.checkpointId).toBe(sourceCheckpoint)
  expect(interrupted.workspaceCleanupPending).not.toBe(true)
  expect(interrupted.pauseBoundaryCleanupPending).not.toBe(true)
  const forkCandidate = interrupted.candidateSnapshotId!
  const forkCheckpoint = interrupted.checkpointId!
  const forkEntryBefore = await readFile(
    workspaceEntry(base.config.userStateRoot, interrupted),
    'utf8'
  )

  // 来源在同一线程继续推进到 R2/C2；旧来源 C1 不再能用于恢复分叉。
  await base.app.generation.replySceneGenerationInteraction({
    projectId: source.projectId,
    sceneId: source.sceneId,
    operationId: source.operationId,
    threadId: source.threadId,
    branchId: source.branchId,
    interactionId: source.interaction!.interactionId,
    checkpointId: sourceCheckpoint,
    candidateSnapshotId: sourceCandidate,
    replyId: 'source-advance-after-fork-reading',
    reply: { kind: 'revise', body: '来源继续写得更克制' }
  })
  await base.run()
  const sourceAfter = await readExecution(base.app, request)
  expect(sourceAfter.state).toBe('waiting')
  expect(sourceAfter.checkpointId).not.toBe(sourceCheckpoint)
  expect(sourceAfter.candidateSnapshotId).not.toBe(sourceCandidate)
  const oldSourceCheckpointRead = await base.app.ports.history
    .readCheckpoint({
      projectId: sourceAfter.projectId,
      sceneId: sourceAfter.sceneId,
      threadId: sourceAfter.threadId,
      branchId: sourceAfter.branchId,
      checkpointId: sourceCheckpoint
    })
    .then(() => true)
    .catch(() => false)
  expect(oldSourceCheckpointRead).toBe(false)

  const modelCalls = { count: 0 }
  const unexpectedModel = (async () => {
    modelCalls.count += 1
    throw new Error('unexpected model request during fork reading recovery')
  }) as unknown as typeof fetch
  const reopened = await reopen(base, unexpectedModel)
  const readCheckpoint = vi.spyOn(reopened.app.ports.history, 'readCheckpoint')
  const client = clientFor(controllerFor(reopened.app))
  await expect(
    client.resume({
      ...identityOf(interrupted),
      checkpointId: forkCheckpoint,
      candidateSnapshotId: forkCandidate
    })
  ).resolves.toMatchObject({ code: ErrorCodes.success })
  expect(modelCalls.count).toBe(0)
  const requestedCheckpoints = readCheckpoint.mock.calls.map(([value]) => value.checkpointId)
  expect(requestedCheckpoints).toContain(forkCheckpoint)

  await reopened.run()
  expect(modelCalls.count).toBe(0)
  const recovered = await readExecution(reopened.app, forkScope)
  expect(recovered.state).toBe('waiting')
  expect(recovered.interaction?.kind).toBe('review')
  expect(recovered.candidateSnapshotId).toBe(forkCandidate)
  expect(recovered.checkpointId).not.toBe(sourceCheckpoint)
  expect(recovered.forkRequest).toBeUndefined()
  expect(recovered.fork?.candidateSnapshotId).toBe(sourceCandidate)
  expect(await readFile(workspaceEntry(base.config.userStateRoot, recovered), 'utf8')).toBe(
    forkEntryBefore
  )
  expect(await readExecution(reopened.app, request)).toEqual(sourceAfter)
  expect(await officialFacts(base)).toEqual(official)
  expect(requestedCheckpoints).not.toContain(sourceCheckpoint)
})
