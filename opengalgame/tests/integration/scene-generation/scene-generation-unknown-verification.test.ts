/**
 * R2：写入/提交待核对现场的显式“核对结果”入口。
 *
 * 只走真实装配、真实候选修订/账本/工作区和控制服务；模型由可控 fetch 提供。
 * 不启动 Electron、浏览器或页面，也不重跑冻结验收。
 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

import type { SceneGenerationScopeDTO } from '@application/scene-generation/dto/SceneGenerationDTO'
import type { SceneGenerationExecution } from '@application/scene-generation/models/SceneGenerationExecution'
import { toRenderStatusVO } from '@application/scene-generation/mapping/SceneGenerationRenderProjection'
import {
  canResumeUnfinishedRecovery,
  canVerifyUnknownResult,
  unfinishedRecoveryIssue
} from '@application/scene-generation/policies/SceneGenerationRecoveryBoundary'
import { SceneGenerationWriteOutcomeUnknown } from '@application/scene-generation/errors/SceneGenerationWriteOutcomeUnknown'
import { safeFailureWithDiagnosticRef } from '@application/scene-generation/services/impl/SceneGenerationFailureFacts'
import {
  readDurableEffects,
  writeDurableEffect
} from '@infrastructure/workflow/execution/durableEffect'
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
  generationFixture,
  request,
  type GenerationFixture
} from '../../../../harness/acceptance/support/generationFixture'

const access = { trusted: true, requestId: 'unknown-verification-test' }

afterEach(() => {
  vi.restoreAllMocks()
})

function identityOf(
  execution: SceneGenerationExecution
): SceneGenerationScopeDTO & { threadId: string; branchId: string } {
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
  scope: SceneGenerationScopeDTO
): Promise<SceneGenerationExecution> {
  const execution = await app.ports.executions.readExecution(scope)
  if (!execution) throw new Error('执行记录不存在')
  return execution
}

function logger(): LoggerGateway {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  }
}

/** 走冻结的既有 resume 通道，不新增 IPC 方法或桥接能力。 */
function clientFor(app: GenerationFixture['app']): SceneGenerationClientImpl {
  const controller = new SceneGenerationController(
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
  return new SceneGenerationClientImpl({
    resumeSceneGeneration: (value: unknown) => controller.resume(value, access)
  } as unknown as DesktopBridge)
}

function stateRootOf(base: GenerationFixture): string {
  return join(base.config.userStateRoot, 'ai')
}

function workspaceRoot(
  base: GenerationFixture,
  execution: Pick<SceneGenerationExecution, 'projectId' | 'threadId' | 'operationId'>
): string {
  return join(
    stateRootOf(base),
    'projects',
    execution.projectId,
    'threads',
    execution.threadId,
    'workspaces',
    execution.operationId
  )
}

function workspaceEntry(base: GenerationFixture, execution: SceneGenerationExecution): string {
  return join(workspaceRoot(base, execution), 'game/scene/start.txt')
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
  app: GenerationFixture['app']
): Promise<readonly SceneGenerationExecution[]> {
  return app.ports.executions.listSceneExecutions({
    projectId: request.projectId,
    sceneId: request.sceneId,
    limit: 100
  })
}

async function effectsSnapshot(
  base: GenerationFixture,
  execution: Pick<SceneGenerationExecution, 'projectId' | 'threadId' | 'operationId'>
): Promise<string> {
  const directory = join(
    stateRootOf(base),
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

/**
 * 把已发布的候选写入回执改回 started：模拟“修订已落盘、完成回执未写”的真实窗口。
 * 只用于测试装配的账本，不改工作区、候选或正式作品。
 */
async function makeWriteUnsettled(
  base: GenerationFixture,
  execution: SceneGenerationExecution
): Promise<void> {
  const root = stateRootOf(base)
  const identity = {
    projectId: execution.projectId,
    threadId: execution.threadId,
    operationId: execution.operationId
  }
  const effects = await readDurableEffects(root, identity)
  const target = effects.find(
    (effect) =>
      effect.kind === 'fileWrite' &&
      effect.status === 'completed' &&
      effect.candidateRevision === execution.candidateSnapshotId
  )
  if (!target) throw new Error('缺少可改写的候选写入回执')
  await writeDurableEffect(root, identity, {
    operationId: target.operationId,
    stepId: target.stepId,
    inputDigest: target.inputDigest,
    status: 'started',
    kind: target.kind
  })
}

async function generateReviewed(base: GenerationFixture): Promise<SceneGenerationExecution> {
  await base.app.generation.generateScene({ ...request, reviewCandidate: true })
  await base.run()
  return readExecution(base.app, request)
}

async function acceptReviewed(base: GenerationFixture): Promise<SceneGenerationExecution> {
  const waiting = await generateReviewed(base)
  await base.app.generation.replySceneGenerationInteraction({
    ...identityOf(waiting),
    interactionId: waiting.interaction!.interactionId,
    checkpointId: waiting.checkpointId!,
    candidateSnapshotId: waiting.candidateSnapshotId!,
    replyId: 'accept-for-verification',
    reply: { kind: 'accept' }
  })
  await base.run()
  return readExecution(base.app, identityOf(waiting))
}

async function forceUnknown(
  base: GenerationFixture,
  execution: SceneGenerationExecution,
  interruptReason: 'writeUnknown' | 'commitUnknown'
): Promise<SceneGenerationExecution> {
  return base.app.ports.executions.writeExecution({
    ...execution,
    state: 'interrupted',
    step: undefined,
    interaction: undefined,
    pendingReply: undefined,
    interruptReason,
    failure: safeFailureWithDiagnosticRef(
      interruptReason === 'writeUnknown'
        ? new SceneGenerationWriteOutcomeUnknown('候选写入回执不明')
        : new Error('formal commit acknowledgement lost')
    ),
    requiresCleanup: interruptReason === 'commitUnknown',
    cancellationRequested: false,
    ...(interruptReason === 'writeUnknown' ? { checkpointId: undefined } : {}),
    ...(interruptReason === 'commitUnknown' ? { result: undefined } : {}),
    sequence: execution.sequence + 1
  })
}

it('[R2] 写入证据恢复：显式核对进入既有审阅门，不新增提交或模型调用', async () => {
  const base = await generationFixture()
  const waiting = await generateReviewed(base)
  const official = await officialFacts(base)
  const writeUnknown = await forceUnknown(base, waiting, 'writeUnknown')
  await makeWriteUnsettled(base, writeUnknown)
  const operationsBefore = (await listOperations(base.app)).length
  const modelCallsBefore = base.bodies.length
  const entryBefore = await readFile(workspaceEntry(base, writeUnknown), 'utf8')
  const candidateBefore = await base.app.ports.artifacts.readCandidate(
    writeUnknown,
    writeUnknown.candidateSnapshotId!
  )

  const projected = toRenderStatusVO(writeUnknown, false, { resume: true, pause: true }, false)
  expect(projected.canVerifyResult).toBe(true)
  expect(projected.canCancel).toBe(false)
  expect(projected.canResume).toBe(false)

  const identity = identityOf(writeUnknown)
  const result = await base.app.control.verifyUnknownResult(identity)
  expect(result.outcome).toBe('candidateWritten')
  expect(result.message).toContain('已确认候选写入')
  expect(result.status.state).toBe('pending')
  expect(base.jobs).toHaveLength(1)
  expect(base.bodies.length).toBe(modelCallsBefore)
  expect((await listOperations(base.app)).length).toBe(operationsBefore)

  await expect(base.app.control.verifyUnknownResult(identity)).rejects.toMatchObject({
    code: ErrorCodes.operationConflict
  })
  expect(base.jobs).toHaveLength(1)

  await base.run()
  const reviewed = await readExecution(base.app, identity)
  expect(reviewed.state).toBe('waiting')
  expect(reviewed.interaction?.kind).toBe('review')
  expect(reviewed.candidateSnapshotId).toBe(writeUnknown.candidateSnapshotId)
  expect(reviewed.checkpointId).toBeDefined()
  expect(await readFile(workspaceEntry(base, reviewed), 'utf8')).toBe(entryBefore)
  const recoveredEffects = await readDurableEffects(stateRootOf(base), identity)
  expect(recoveredEffects.every((effect) => effect.status === 'completed')).toBe(true)
  expect(recoveredEffects).toContainEqual(
    expect.objectContaining({
      status: 'completed',
      candidateRevision: writeUnknown.candidateSnapshotId
    })
  )
  expect(
    await base.app.ports.artifacts.readCandidate(reviewed, reviewed.candidateSnapshotId!)
  ).toEqual(candidateBefore)
  expect(base.bodies.length).toBe(modelCallsBefore)
  expect((await listOperations(base.app)).length).toBe(operationsBefore)
  expect(await officialFacts(base)).toEqual(official)

  // 迟到重复请求：已进入审阅门后重发只返回当前事实，不再次派发或写记录。
  const duplicate = await base.app.control.verifyUnknownResult(identity)
  expect(duplicate.outcome).toBe('candidateWritten')
  expect(duplicate.message).toContain('审阅门')
  expect(base.jobs).toHaveLength(0)
  expect(await readExecution(base.app, identity)).toEqual(reviewed)
  expect(base.bodies.length).toBe(modelCallsBefore)
})

it('[R2] 写入证据仍不足：保持待核对，候选、工作区、账本与操作记录不变', async () => {
  const base = await generationFixture()
  const waiting = await generateReviewed(base)
  const writeUnknown = await forceUnknown(base, waiting, 'writeUnknown')
  // 账本里出现无法归属的结果不明副作用：恢复只能返回待核对，不能猜写入。
  await writeDurableEffect(
    stateRootOf(base),
    {
      projectId: writeUnknown.projectId,
      threadId: writeUnknown.threadId,
      operationId: writeUnknown.operationId
    },
    {
      operationId: writeUnknown.operationId,
      stepId: 'generate-99',
      inputDigest: 'not-a-real-digest',
      status: 'unknown',
      kind: 'fileWrite'
    }
  )
  const official = await officialFacts(base)
  const operationsBefore = (await listOperations(base.app)).length
  const modelCallsBefore = base.bodies.length
  const entryBefore = await readFile(workspaceEntry(base, writeUnknown), 'utf8')
  const effectsBefore = await effectsSnapshot(base, writeUnknown)
  const candidateBefore = await base.app.ports.artifacts.readCandidate(
    writeUnknown,
    writeUnknown.candidateSnapshotId!
  )

  const identity = identityOf(writeUnknown)
  const result = await base.app.control.verifyUnknownResult(identity)
  expect(result.outcome).toBe('stillPending')
  expect(result.message).toContain('没有找到可证明的候选写入')
  expect(result.status.state).toBe('interrupted')
  expect(result.status.canCancel).toBe(false)
  expect(await readExecution(base.app, identity)).toEqual(writeUnknown)
  expect(await readFile(workspaceEntry(base, writeUnknown), 'utf8')).toBe(entryBefore)
  expect(await effectsSnapshot(base, writeUnknown)).toBe(effectsBefore)
  expect(
    await base.app.ports.artifacts.readCandidate(writeUnknown, writeUnknown.candidateSnapshotId!)
  ).toEqual(candidateBefore)
  expect(base.jobs).toHaveLength(0)
  expect(base.bodies.length).toBe(modelCallsBefore)
  expect((await listOperations(base.app)).length).toBe(operationsBefore)
  expect(await officialFacts(base)).toEqual(official)

  const duplicate = await base.app.control.verifyUnknownResult(identity)
  expect(duplicate.outcome).toBe('stillPending')
  expect(await readExecution(base.app, identity)).toEqual(writeUnknown)
  expect(base.jobs).toHaveLength(0)
})

it('[R2] 提交证据恢复：按原提交结算，不新增提交或模型调用', async () => {
  const base = await generationFixture()
  const committed = await acceptReviewed(base)
  expect(committed.state).toBe('succeeded')
  expect(committed.result?.commitId).toBeDefined()
  const official = await officialFacts(base)
  const operationsBefore = (await listOperations(base.app)).length
  const modelCallsBefore = base.bodies.length
  const commitUnknown = await forceUnknown(base, committed, 'commitUnknown')
  expect(commitUnknown.result).toBeUndefined()

  const identity = identityOf(commitUnknown)
  const projected = toRenderStatusVO(commitUnknown, false, { resume: true, pause: true }, false)
  expect(projected.canVerifyResult).toBe(true)
  expect(projected.canCancel).toBe(false)

  const result = await base.app.control.verifyUnknownResult(identity)
  expect(result.outcome).toBe('committed')
  expect(result.message).toContain('已确认作品提交')
  expect(result.status.state).toBe('succeeded')
  expect(result.status.result?.commitId).toBe(committed.result!.commitId)
  expect(base.jobs).toHaveLength(0)
  expect(base.bodies.length).toBe(modelCallsBefore)
  expect((await listOperations(base.app)).length).toBe(operationsBefore)
  expect(await officialFacts(base)).toEqual(official)
  const settled = await readExecution(base.app, identity)
  expect(settled.state).toBe('succeeded')
  expect(settled.result?.commitId).toBe(committed.result!.commitId)

  const duplicate = await base.app.control.verifyUnknownResult(identity)
  expect(duplicate.outcome).toBe('committed')
  expect(base.jobs).toHaveLength(0)
  expect(await officialFacts(base)).toEqual(official)
})

it('[R2] 提交证据为未提交：只如实说明，不推断取消、清理或继续', async () => {
  const base = await generationFixture()
  const waiting = await generateReviewed(base)
  const commitUnknown = await forceUnknown(base, waiting, 'commitUnknown')
  const official = await officialFacts(base)
  const operationsBefore = (await listOperations(base.app)).length
  const modelCallsBefore = base.bodies.length
  const entryBefore = await readFile(workspaceEntry(base, commitUnknown), 'utf8')
  const effectsBefore = await effectsSnapshot(base, commitUnknown)
  const candidateBefore = await base.app.ports.artifacts.readCandidate(
    commitUnknown,
    commitUnknown.candidateSnapshotId!
  )

  const identity = identityOf(commitUnknown)
  const result = await base.app.control.verifyUnknownResult(identity)
  expect(result.outcome).toBe('stillPending')
  expect(result.message).toContain('未发现已提交作品')
  expect(result.status.state).toBe('interrupted')
  expect(result.status.canCancel).toBe(false)
  expect(await readExecution(base.app, identity)).toEqual(commitUnknown)
  expect(await readFile(workspaceEntry(base, commitUnknown), 'utf8')).toBe(entryBefore)
  expect(await effectsSnapshot(base, commitUnknown)).toBe(effectsBefore)
  expect(
    await base.app.ports.artifacts.readCandidate(commitUnknown, commitUnknown.candidateSnapshotId!)
  ).toEqual(candidateBefore)
  expect(base.jobs).toHaveLength(0)
  expect(base.bodies.length).toBe(modelCallsBefore)
  expect((await listOperations(base.app)).length).toBe(operationsBefore)
  expect(await officialFacts(base)).toEqual(official)

  const duplicate = await base.app.control.verifyUnknownResult(identity)
  expect(duplicate.outcome).toBe('stillPending')
  expect(await readExecution(base.app, identity)).toEqual(commitUnknown)
})

it('[R2] 复用既有恢复通道：controller 识别 verify，伪造身份被拒绝且不写记录', async () => {
  const base = await generationFixture()
  const waiting = await generateReviewed(base)
  const commitUnknown = await forceUnknown(base, waiting, 'commitUnknown')
  const operationsBefore = (await listOperations(base.app)).length
  const modelCallsBefore = base.bodies.length
  const client = clientFor(base.app)
  const identity = identityOf(commitUnknown)

  await expect(
    client.verifyUnknownResult({ ...identity, branchId: 'forged-branch' })
  ).resolves.toMatchObject({ code: ErrorCodes.operationConflict })
  await expect(
    client.verifyUnknownResult({ ...identity, threadId: 'forged-thread' })
  ).resolves.toMatchObject({ code: ErrorCodes.operationConflict })
  expect(base.jobs).toHaveLength(0)
  expect(await readExecution(base.app, identity)).toEqual(commitUnknown)

  await expect(client.verifyUnknownResult(identity)).resolves.toMatchObject({
    code: ErrorCodes.success,
    msg: '核对完成',
    data: {
      outcome: 'stillPending',
      message: expect.stringContaining('未发现已提交作品'),
      status: { operationId: commitUnknown.operationId, state: 'interrupted' }
    }
  })
  expect(base.jobs).toHaveLength(0)
  expect(base.bodies.length).toBe(modelCallsBefore)
  expect((await listOperations(base.app)).length).toBe(operationsBefore)
  expect(await readExecution(base.app, identity)).toEqual(commitUnknown)
})

it('[R2] 核对入口与投影共用无检查点准入判据，待核对不获得继续权限', async () => {
  const base = await generationFixture()
  const waiting = await generateReviewed(base)
  const writeUnknown = await forceUnknown(base, waiting, 'writeUnknown')
  const pendingWithoutCheckpoint: SceneGenerationExecution = {
    ...waiting,
    state: 'pending',
    step: 'preparing',
    interaction: undefined,
    pendingReply: undefined,
    checkpointId: undefined,
    interruptReason: undefined
  }
  const runningWithoutCheckpoint: SceneGenerationExecution = {
    ...pendingWithoutCheckpoint,
    state: 'running'
  }
  const cancelledPending: SceneGenerationExecution = {
    ...runningWithoutCheckpoint,
    cancellationRequested: true
  }
  const incomplete: SceneGenerationExecution = {
    ...runningWithoutCheckpoint,
    fingerprint: ''
  }

  const cases = [
    pendingWithoutCheckpoint,
    runningWithoutCheckpoint,
    cancelledPending,
    incomplete,
    writeUnknown,
    waiting
  ]
  for (const execution of cases) {
    expect(canResumeUnfinishedRecovery(execution, false)).toBe(
      unfinishedRecoveryIssue(execution) === null
    )
    expect(canResumeUnfinishedRecovery(execution, true)).toBe(false)
  }
  expect(canVerifyUnknownResult(writeUnknown, false)).toBe(true)
  expect(canVerifyUnknownResult(writeUnknown, true)).toBe(false)
  expect(canVerifyUnknownResult(waiting, false)).toBe(false)

  const issue = unfinishedRecoveryIssue(writeUnknown)
  expect(issue).not.toBeNull()
  await expect(
    base.app.control.resumeUnfinishedSceneGeneration(identityOf(writeUnknown))
  ).rejects.toMatchObject({ code: ErrorCodes.operationConflict, message: issue })
})
