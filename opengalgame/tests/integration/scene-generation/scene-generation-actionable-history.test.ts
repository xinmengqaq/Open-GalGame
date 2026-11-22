/**
 * R1/R4：工作台需要处理的操作发现与分页。
 *
 * 只用真实装配、真实执行记录、真实恢复/核对入口和公共 controller/client：
 * - 写入待核对由真实 GenerationRecovery 产生（分叉来源证据缺失后恢复失败），
 *   不由测试手写 interruptReason，也不手清检查点；随后来源继续推进。
 * - 提交待核对由真实恢复入口在提交回执不明时产生。
 * - 超过一页的待处理记录通过真实 handler 分页读取，验证 schema 上限、独立游标与全量可浏览。
 * 不启动 Electron、浏览器或页面，也不重跑冻结验收。
 */
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

import { createSceneGeneration, type SceneGenerationServices } from '@bootstrap/sceneGeneration'
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

const access = { trusted: true, requestId: 'actionable-history-test' }

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

type Reopened = {
  app: SceneGenerationServices
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
    resumeSceneGeneration: (value: unknown) => controller.resume(value, access)
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

async function generateReviewed(base: GenerationFixture): Promise<SceneGenerationExecution> {
  await base.app.generation.generateScene({ ...request, reviewCandidate: true })
  await base.run()
  return readExecution(base.app, request)
}

function forkSourceEvidencePath(
  base: GenerationFixture,
  execution: SceneGenerationExecution
): string {
  return join(
    base.config.userStateRoot,
    'ai',
    'projects',
    execution.projectId,
    'threads',
    execution.threadId,
    'operations',
    execution.operationId,
    'fork-source.json'
  )
}

async function advanceSourceLater(
  app: Reopened['app'],
  source: SceneGenerationExecution
): Promise<SceneGenerationExecution> {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(Date.now() + 60_000))
  const advanced = await app.ports.executions.writeExecution({
    ...source,
    sequence: source.sequence + 2
  })
  vi.useRealTimers()
  return advanced
}

/**
 * 测试装配的相邻待处理记录：只用于验证单条不可读检查点不会遮住其它条目。
 * 它不是恢复产物，不参与 R1 的写入/提交待核对断言。
 */
function pendingWithoutCheckpoint(
  source: SceneGenerationExecution,
  operationId: string
): SceneGenerationExecution {
  return {
    ...source,
    operationId,
    threadId: `thread-${operationId}`,
    branchId: `branch-${operationId}`,
    fingerprint: `fingerprint-${operationId}`,
    mode: undefined,
    state: 'pending',
    step: 'preparing',
    attempt: 0,
    sequence: 0,
    checkpointId: undefined,
    candidateSnapshotId: undefined,
    interaction: undefined,
    pendingReply: undefined,
    replies: [],
    fork: undefined,
    forkRequest: undefined,
    result: undefined,
    live: undefined,
    failure: undefined,
    timeline: undefined,
    artifactValidation: undefined,
    publishedCandidates: undefined,
    requiresCleanup: undefined,
    cancellationRequested: undefined,
    interruptReason: undefined,
    workspace: undefined,
    createdAt: undefined,
    updatedAt: undefined
  }
}

it('[R1] 真实写入待核对带合成检查点仍被发现；来源更晚、普通历史存在也不遮蔽', async () => {
  const base = await generationFixture()
  const source = await generateReviewed(base)
  const forkOperationId = randomUUID()
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
  const forkScope = {
    projectId: request.projectId,
    sceneId: request.sceneId,
    operationId: forkOperationId
  }
  const fork = await readExecution(base.app, forkScope)
  expect(fork.state).toBe('pending')
  expect(fork.checkpointId).toBeUndefined()
  const modelCallsBefore = base.bodies.length

  // 模拟来源证据在磁盘上丢失：重开后的真实分叉工作流证明失败，
  // GenerationRecovery 写入中断并补合成检查点；测试不手写该记录。
  await rm(forkSourceEvidencePath(base, fork), { force: true })
  base.jobs.length = 0
  const reopened = await reopen(base)
  const client = clientFor(controllerFor(reopened.app))

  const initial = await client.listHistory({ projectId: request.projectId, sceneId: request.sceneId, limit: 20 })
  expect(initial.code).toBe(ErrorCodes.success)
  expect(
    initial.data?.unfinished.find((item) => item.operationId === forkOperationId)
      ?.canResumeUnfinished
  ).toBe(true)

  await expect(client.resumeUnfinished(identityOf(fork))).resolves.toMatchObject({
    code: ErrorCodes.success
  })
  await expect(reopened.run()).rejects.toThrow()
  const recovered = await readExecution(reopened.app, forkScope)
  expect(recovered.state).toBe('interrupted')
  expect(recovered.interruptReason).toBe('writeUnknown')
  // 真实恢复在“原本没有检查点”的失败补写中生成合成检查点。
  expect(recovered.checkpointId).toBeDefined()
  expect(base.bodies.length).toBe(modelCallsBefore)

  // 同页再放一条无检查点遗留：合成检查点不可读只能降级该条，不能遮住这一条。
  const neighbour = await reopened.app.ports.executions.createExecution(
    pendingWithoutCheckpoint(recovered, 'operation-neighbour')
  )

  // 来源在同一线程继续推进，记录时间比待核对分叉更晚；普通历史也存在。
  const advanced = await advanceSourceLater(reopened.app, source)
  expect(advanced.updatedAt! > recovered.updatedAt!).toBe(true)

  const loaded = await readGenerationHistory(client, request.projectId, request.sceneId)
  if (loaded.kind === 'error') throw new Error(loaded.message)
  expect(loaded.kind).toBe('status')
  expect(loaded.kind === 'status' ? loaded.status.operationId : null).toBe(source.operationId)
  const neighbourRow = unfinishedSelectionOf(loaded.unfinished, neighbour.operationId, {
    projectId: request.projectId,
    sceneId: request.sceneId
  })
  expect(neighbourRow?.canResumeUnfinished).toBe(true)
  const actionable = unfinishedSelectionOf(loaded.unfinished, forkOperationId, {
    projectId: request.projectId,
    sceneId: request.sceneId
  })
  expect(actionable?.checkpointId).toBeDefined()
  expect(actionable?.canVerifyResult).toBe(true)
  expect(actionable?.canResume).toBe(false)
  expect(actionable?.canResumeUnfinished).toBeUndefined()
  expect(actionable?.canCancel).toBe(false)

  // 选中后按操作身份读取真实状态，再走既有核对入口；只读事实，不新增运行。
  const status = await client.status(forkScope)
  expect(status.code).toBe(ErrorCodes.success)
  expect(status.data?.canVerifyResult).toBe(true)
  const verified = await client.verifyUnknownResult(identityOf(recovered))
  expect(verified.code).toBe(ErrorCodes.success)
  expect(verified.data?.outcome).toBe('stillPending')
  expect(verified.data?.message).toContain('没有找到可证明的候选写入回执')
  expect(verified.data?.status.state).toBe('interrupted')
  expect(reopened.jobs).toHaveLength(0)
  expect(base.bodies.length).toBe(modelCallsBefore)
})

it('[R1] 真实提交待核对带检查点仍被发现，普通历史与选择核对内容一致', async () => {
  const base = await generationFixture()
  const waiting = await generateReviewed(base)
  const scope = { ...request }
  await base.app.generation.replySceneGenerationInteraction({
    ...identityOf(waiting),
    interactionId: waiting.interaction!.interactionId,
    checkpointId: waiting.checkpointId!,
    candidateSnapshotId: waiting.candidateSnapshotId!,
    replyId: 'accept-to-unknown',
    reply: { kind: 'accept' }
  })
  // 只故障注入“提交响应丢失且回执事实不可判定”；中断记录仍由真实 GenerationRecovery 写入。
  const commit = vi
    .spyOn(base.app.ports.versions, 'commitCandidate')
    .mockRejectedValue(new Error('提交响应丢失'))
  const receipts = vi
    .spyOn(base.app.ports.versions, 'readOperationCommit')
    .mockResolvedValue({ state: 'unknown' })
  await expect(base.run()).rejects.toThrow()
  receipts.mockRestore()
  commit.mockRestore()

  const unknown = await readExecution(base.app, scope)
  expect(unknown.state).toBe('interrupted')
  expect(unknown.interruptReason).toBe('commitUnknown')
  expect(unknown.checkpointId).toBeDefined()

  const reopened = await reopen(base)
  const client = clientFor(controllerFor(reopened.app))
  const loaded = await readGenerationHistory(client, request.projectId, request.sceneId)
  if (loaded.kind === 'error') throw new Error(loaded.message)
  // 普通历史里出现的是同一条待核对摘要，但发现列表仍独立给出可核对状态。
  expect(loaded.kind === 'status' ? loaded.status.operationId : null).toBe(unknown.operationId)
  expect(loaded.unfinished.filter((item) => item.operationId === unknown.operationId)).toHaveLength(
    1
  )
  const selected = unfinishedSelectionOf(loaded.unfinished, unknown.operationId, {
    projectId: request.projectId,
    sceneId: request.sceneId
  })
  expect(selected?.checkpointId).toBe(unknown.checkpointId)
  expect(selected?.canVerifyResult).toBe(true)
  expect(selected?.canResume).toBe(false)
  expect(selected?.canCancel).toBe(false)

  const verified = await client.verifyUnknownResult(identityOf(unknown))
  expect(verified.code).toBe(ErrorCodes.success)
  expect(verified.data?.outcome).toBe('stillPending')
  expect(verified.data?.message).toContain('未发现已提交作品')
  expect(verified.data?.status.operationId).toBe(unknown.operationId)
  expect(verified.data?.status.state).toBe('interrupted')
  expect(reopened.jobs).toHaveLength(0)
})

it('[R4] 101 条需要处理的操作按独立游标分页，schema 不溢出且全部可浏览', async () => {
  const base = await generationFixture()
  const source = await generateReviewed(base)
  // 来源保留真实检查点供历史游标使用，但改成终态，避免它作为阻断 generate 进入发现列表。
  await base.app.ports.executions.writeExecution({
    ...source,
    state: 'cancelled',
    step: undefined,
    interaction: undefined,
    pendingReply: undefined,
    sequence: source.sequence + 1
  })
  const seeded: string[] = []
  for (let index = 0; index < 101; index += 1) {
    const recorded = await base.app.ports.executions.createExecution(
      pendingWithoutCheckpoint(source, `operation-pending-${index}`)
    )
    seeded.push(recorded.operationId)
  }
  const client = clientFor(controllerFor(base.app))
  const first = await client.listHistory({
    projectId: request.projectId,
    sceneId: request.sceneId,
    limit: 20
  })
  expect(first.code).toBe(ErrorCodes.success)
  const firstPage = first.data!
  // 100 条正好落在响应 schema 的单数组上限内；第 101 条靠独立游标继续。
  expect(firstPage.unfinished).toHaveLength(100)
  expect(firstPage.unfinishedNextCursor).toBeDefined()
  expect(firstPage.unfinished.some((item) => item.operationId === source.operationId)).toBe(false)

  const second = await client.listHistory({
    projectId: request.projectId,
    sceneId: request.sceneId,
    limit: 20,
    unfinishedCursor: firstPage.unfinishedNextCursor
  })
  expect(second.code).toBe(ErrorCodes.success)
  expect(second.data?.items).toEqual([])
  expect(second.data?.unfinished).toHaveLength(1)
  expect(second.data?.unfinishedNextCursor).toBeUndefined()

  const seen = new Set([
    ...firstPage.unfinished.map((item) => item.operationId),
    ...(second.data?.unfinished.map((item) => item.operationId) ?? [])
  ])
  expect(seen.size).toBe(101)
  expect([...seeded].sort()).toEqual([...seen].sort())

  // 工作台加载器合并全部待处理页后，第 101 条仍可被选择。
  const loaded = await readGenerationHistory(client, request.projectId, request.sceneId)
  if (loaded.kind === 'error') throw new Error(loaded.message)
  expect(loaded.unfinished).toHaveLength(101)
  expect(new Set(loaded.unfinished.map((item) => item.operationId))).toEqual(seen)
  const oldest = unfinishedSelectionOf(loaded.unfinished, seeded[0]!, {
    projectId: request.projectId,
    sceneId: request.sceneId
  })
  expect(oldest?.operationId).toBe(seeded[0])

  // 历史游标与待处理游标不能在同一请求里混用。
  const mixed = await client.listHistory({
    projectId: request.projectId,
    sceneId: request.sceneId,
    limit: 20,
    cursor: source.checkpointId!,
    unfinishedCursor: firstPage.unfinishedNextCursor
  })
  expect(mixed.code).toBe(ErrorCodes.invalidRequest)
}, 30000)
