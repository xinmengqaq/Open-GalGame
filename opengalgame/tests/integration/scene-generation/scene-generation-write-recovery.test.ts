/**
 * 写后恢复与候选归属的消费者回归。
 *
 * 只用真实 createSceneGeneration 装配、真实磁盘工作区、不可变修订和副作用账本；
 * 模型由可控 OpenAI-compatible fetch 提供，故障由模块栅栏注入，不改产品代码。
 *
 * 断言口径：
 * - 作者可见：执行记录、历史检查点、候选读取与审阅/修正交互；
 * - 正式工程：入口文件与 git HEAD 在未接受前必须不变；
 * - 账本：effects 目录、候选修订 refs 与模型请求数；
 * - 普通错误与作者取消分开，读取成功不等于写入已结算。
 */
import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import { cp, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import * as git from 'isomorphic-git'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createSceneGeneration, type SceneGenerationServices } from '@bootstrap/sceneGeneration'
import { ManageProjectVersioning } from '@application/project-versioning/services/impl/ManageProjectVersioning'
import type { GenerateSceneDTO } from '@application/scene-generation/dto/SceneGenerationDTO'
import type { SceneGenerationExecution } from '@application/scene-generation/models/SceneGenerationExecution'
import { toRenderStatusVO } from '@application/scene-generation/mapping/SceneGenerationRenderProjection'
import { safeFailureWithDiagnosticRef } from '@application/scene-generation/services/impl/SceneGenerationFailureFacts'
import type { ProjectApplicationService } from '@application/projects/services/ProjectApplicationService'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { ProjectController } from '@interfaces/ipc/controllers/ProjectController'
import { IpcErrorMapper } from '@interfaces/ipc/errors/IpcErrorMapper'
import { IpcExceptionHandler } from '@interfaces/ipc/errors/IpcExceptionHandler'
import type { DesktopBridge } from '@interfaces/client/DesktopBridge'
import { SceneGenerationClientImpl } from '@interfaces/scene-generation/client/SceneGenerationClientImpl'
import {
  SceneGenerationController,
  type SceneGenerationApplicationGateway
} from '@interfaces/scene-generation/ipc/SceneGenerationController'
import { createProjectVersioningGateways } from '@infrastructure/project-versioning/createProjectVersioningGateways'
import { candidateReplyStepTag } from '@infrastructure/scene-generation/workflow/graph/candidateRevision'
import { piReviewCheckpointId } from '@infrastructure/scene-generation/workflow/piReviewCheckpoint'
import type * as VerifiedFileWriteModule from '@infrastructure/ai/tools/verifiedFileWrite'
import type * as WrittenFileLedgerModule from '@infrastructure/ai/execution/writtenFileLedger'
import type * as DurableEffectModule from '@infrastructure/workflow/execution/durableEffect'
import {
  generationFixture,
  request,
  validScript,
  type GenerationFixture
} from '../../../../harness/acceptance/support/generationFixture'
import { clarificationAnswerFixture } from './scene-generation-clarification-fixture'
import { streamingFetch } from '../ai/streamingFetch'

const faults = vi.hoisted(() => ({
  /** 'none' | 'before' | 'after'（writeVerifiedBytes 写盘后抛错） */
  fileWrite: 'none' as 'none' | 'before' | 'after',
  /** 写盘并记录后、工具回执返回前抛错。 */
  loseReceipt: false,
  /** 完成回执写入前的故障栅栏；抛错模拟进程终止。 */
  completedEffectFence: null as
    | null
    | ((args: {
        stateRoot: string
        identity: { operationId: string; projectId: string; threadId: string }
        record: { stepId: string; status: string }
      }) => Promise<void>),
  /** 成功落盘的完成记录，用于核对同一 started 只补一次结算。 */
  completedWrites: [] as Array<{ stepId: string; candidateRevision?: string }>
}))

vi.mock('@infrastructure/ai/tools/verifiedFileWrite', async (importOriginal) => {
  const actual = await importOriginal<typeof VerifiedFileWriteModule>()
  return {
    ...actual,
    writeVerifiedBytes: async (...args: Parameters<typeof actual.writeVerifiedBytes>) => {
      if (faults.fileWrite === 'before') throw new Error('disk unavailable')
      await actual.writeVerifiedBytes(...args)
      if (faults.fileWrite === 'after') throw new Error('write acknowledgement lost')
    }
  }
})

vi.mock('@infrastructure/ai/execution/writtenFileLedger', async (importOriginal) => {
  const actual = await importOriginal<typeof WrittenFileLedgerModule>()
  return {
    ...actual,
    recordWrittenFile: (...args: Parameters<typeof actual.recordWrittenFile>) => {
      if (faults.loseReceipt) throw new Error('tool receipt lost after write fact')
      return actual.recordWrittenFile(...args)
    }
  }
})

vi.mock('@infrastructure/workflow/execution/durableEffect', async (importOriginal) => {
  const actual = await importOriginal<typeof DurableEffectModule>()
  return {
    ...actual,
    writeDurableEffect: async (...args: Parameters<typeof actual.writeDurableEffect>) => {
      const record = args[2]
      if (record.status === 'completed' && faults.completedEffectFence) {
        const identity = args[1] as {
          operationId: string
          projectId: string
          threadId: string
        }
        await faults.completedEffectFence({
          stateRoot: args[0],
          identity,
          record: { stepId: record.stepId, status: record.status }
        })
        throw new Error('fault fence: process terminated before completed effect')
      }
      await actual.writeDurableEffect(...args)
      if (record.status === 'completed')
        faults.completedWrites.push({
          stepId: record.stepId,
          ...(record.candidateRevision === undefined
            ? {}
            : { candidateRevision: record.candidateRevision })
        })
    }
  }
})

type CandidateEffect = {
  operationId: string
  stepId: string
  status: string
  inputDigest: string
  kind: string
  resultDigest?: string
  candidateRevision?: string
}

const extraRoots: string[] = []

afterEach(async () => {
  faults.fileWrite = 'none'
  faults.loseReceipt = false
  faults.completedEffectFence = null
  faults.completedWrites = []
  await Promise.all(
    extraRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  )
  vi.restoreAllMocks()
})

async function effectRecords(userStateRoot: string, scope: ScopeLike): Promise<CandidateEffect[]> {
  const directory = join(
    userStateRoot,
    'ai',
    'projects',
    scope.projectId,
    'threads',
    scope.threadId,
    'operations',
    scope.operationId,
    'effects'
  )
  const names = (
    await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
  ).filter((name) => name.endsWith('.json'))
  return Promise.all(
    names.map(
      async (name) => JSON.parse(await readFile(join(directory, name), 'utf8')) as CandidateEffect
    )
  )
}

async function effectFile(
  userStateRoot: string,
  scope: ScopeLike,
  stepId: string
): Promise<string> {
  return join(
    userStateRoot,
    'ai',
    'projects',
    scope.projectId,
    'threads',
    scope.threadId,
    'operations',
    scope.operationId,
    'effects',
    `${stepId}.json`
  )
}

type ScopeLike = { projectId: string; sceneId: string; threadId: string; operationId: string }

type ModelMessage = {
  role: string
  content?: unknown
  tool_calls?: Array<{ function: { name: string } }>
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .flatMap((block) =>
      block && typeof block === 'object' && 'text' in block && typeof block.text === 'string'
        ? [block.text]
        : []
    )
    .join('')
}

function expectedRevisionOf(messages: ModelMessage[]): string {
  const facts = messages
    .filter((message) => message.role === 'user')
    .map((message) => contentText(message.content))
    .at(-1)
  const matched = facts?.match(/"revision"\s*:\s*"([^"]+)"/)
  return matched?.[1] ?? 'absent'
}

function toolCallResponse(messages: ModelMessage[], content: string, id: string): Response {
  return Response.json({
    object: 'chat.completion',
    created: 1,
    model: 'test',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id,
              type: 'function',
              function: {
                name: 'writeCandidate',
                arguments: JSON.stringify({
                  path: 'game/scene/start.txt',
                  expectedRevision: expectedRevisionOf(messages),
                  content
                })
              }
            }
          ]
        },
        finish_reason: 'tool_calls'
      }
    ],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }
  })
}

function stopResponse(): Response {
  return Response.json({
    object: 'chat.completion',
    created: 1,
    model: 'test',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: '已结束本轮。' },
        finish_reason: 'stop'
      }
    ],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
  })
}

function modelErrorResponse(message = 'model stream ended unexpectedly'): Response {
  return Response.json({ error: { message } }, { status: 500 })
}

function appWithModel(
  base: GenerationFixture,
  fetcher: typeof fetch
): Promise<SceneGenerationServices> {
  return createSceneGeneration({
    ...base.config,
    fetcher,
    dispatch: (job: () => Promise<void>) => {
      base.jobs.push(job)
    }
  })
}

async function reopen(
  base: GenerationFixture,
  userStateRoot: string,
  fetcher: typeof fetch
): Promise<{
  app: SceneGenerationServices
  jobs: Array<() => Promise<void>>
  run: () => Promise<void>
}> {
  const jobs: Array<() => Promise<void>> = []
  const app = await createSceneGeneration({
    ...base.config,
    userStateRoot,
    fetcher,
    dispatch: (job: () => Promise<void>) => {
      jobs.push(job)
    },
    publishProgress: () => {},
    versioning: new ManageProjectVersioning({
      ...createProjectVersioningGateways(userStateRoot),
      nextId: () => randomUUID()
    })
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

function failModel(calls: { count: number }): typeof fetch {
  return streamingFetch(async () => {
    calls.count += 1
    return modelErrorResponse('unexpected model request during recovery')
  })
}

function writeThenStopModel(calls: { count: number }): typeof fetch {
  return streamingFetch(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: ModelMessage[] }
    const last = body.messages.at(-1)
    calls.count += 1
    return last?.role === 'user'
      ? toolCallResponse(body.messages, validScript, `w-${calls.count}`)
      : stopResponse()
  })
}

function writeInvalidThenFailModel(input: {
  calls: { count: number }
  turns: { count: number }
}): typeof fetch {
  return streamingFetch(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: ModelMessage[] }
    const last = body.messages.at(-1)
    input.calls.count += 1
    if (last?.role === 'user') {
      input.turns.count += 1
      return input.turns.count === 1
        ? toolCallResponse(body.messages, validScript.replace('station.svg', 'missing.svg'), 'w-1')
        : modelErrorResponse('second pass model stream failed')
    }
    return stopResponse()
  })
}

function writeTwiceThenStopModel(calls: { count: number }): typeof fetch {
  let writes = 0
  return streamingFetch(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: ModelMessage[] }
    const last = body.messages.at(-1)
    calls.count += 1
    if (last?.role === 'user') {
      writes += 1
      return toolCallResponse(
        body.messages,
        writes === 1 ? validScript.replace('station.svg', 'missing.svg') : validScript,
        `w-${writes}`
      )
    }
    return stopResponse()
  })
}

async function runQueued(base: GenerationFixture): Promise<void> {
  const job = base.jobs.shift()
  if (!job) throw new Error('缺少任务')
  await job()
}

async function replyRevise(
  app: SceneGenerationServices,
  execution: SceneGenerationExecution,
  replyId: string,
  body: string
): Promise<void> {
  const interaction = execution.interaction!
  await app.generation.replySceneGenerationInteraction({
    projectId: execution.projectId,
    sceneId: execution.sceneId,
    operationId: execution.operationId,
    threadId: execution.threadId,
    branchId: execution.branchId,
    interactionId: interaction.interactionId,
    checkpointId: interaction.checkpointId,
    candidateSnapshotId: interaction.candidateSnapshotId ?? execution.candidateSnapshotId!,
    replyId,
    reply: { kind: 'revise', body }
  })
}

async function runQueuedIgnoringFailure(base: GenerationFixture): Promise<void> {
  await runQueued(base).catch(() => undefined)
}

async function newSnapshotRoot(prefix: string): Promise<string> {
  const work = await mkdtemp(join(tmpdir(), prefix))
  extraRoots.push(work)
  return join(work, 'state')
}

async function digestAt(path: string): Promise<string> {
  try {
    return createHash('sha256')
      .update(await readFile(path))
      .digest('hex')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw error
  }
}

/**
 * 在崩溃栅栏处复制用户状态目录，模拟进程在该点终止。
 * 只接受执行记录、effects 与草稿在复制期间保持不变；进度定时器并发写时重试。
 * 不要求候选已记录：首次写入开始或 save→record 之间也必须能取到原现场。
 */
async function stateSignature(userStateRoot: string, scope: ScopeLike): Promise<string> {
  const executionPath = join(
    userStateRoot,
    'scene-generation',
    'projects',
    scope.projectId,
    'executions.json'
  )
  const effectDirectory = join(
    userStateRoot,
    'ai',
    'projects',
    scope.projectId,
    'threads',
    scope.threadId,
    'operations',
    scope.operationId,
    'effects'
  )
  const names = (
    await readdir(effectDirectory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
  )
    .filter((name) => name.endsWith('.json'))
    .sort()
  return [
    await digestAt(executionPath),
    await digestAt(workspaceEntry(userStateRoot, scope)),
    ...(await Promise.all(names.map((name) => digestAt(join(effectDirectory, name)))))
  ].join('|')
}

type StoredExecution = {
  operationId: string
  candidateSnapshotId?: string
  checkpointId?: string
  state: string
  cancellationRequested?: boolean
  pendingReply?: unknown
  replies?: readonly { replyId: string }[]
  interaction?: {
    interactionId: string
    kind: string
    checkpointId: string
    candidateSnapshotId?: string
  }
  forkRequest?: unknown
}

async function copyStableState(
  source: string,
  destination: string,
  scope: ScopeLike
): Promise<StoredExecution> {
  let reason = '未尝试'
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await rm(destination, { recursive: true, force: true })
    const before = await stateSignature(source, scope)
    await cp(source, destination, { recursive: true, force: true })
    const after = await stateSignature(source, scope)
    if (before !== after) {
      reason = '源状态在复制期间变化'
      continue
    }
    try {
      const parsed = JSON.parse(
        await readFile(
          join(destination, 'scene-generation/projects', scope.projectId, 'executions.json'),
          'utf8'
        )
      ) as { executions: StoredExecution[] }
      const execution = parsed.executions.find((item) => item.operationId === scope.operationId)
      if (execution) return execution
      reason = '复制后缺少目标操作'
    } catch (error) {
      reason = `复制后读取失败：${String(error)}`
    }
    // 进度发布器用真实 1.5s 定时器，假定时器无法替代这里对文件系统并发的真实让出。
    await new Promise((resolve) => setTimeout(resolve, 60))
  }
  throw new Error(`状态目录未能在持久边界稳定复制：${reason}`)
}

async function snapshotUserState(
  source: string,
  destination: string,
  scope: ScopeLike,
  expected?: { stepId?: string }
): Promise<void> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const execution = await copyStableState(source, destination, scope)
    const effects = await effectRecords(destination, scope)
    const started = effects.filter((effect) => effect.status === 'started')
    if (
      (execution.state === 'running' || execution.state === 'pending') &&
      started.length === 1 &&
      (expected?.stepId === undefined || started[0]?.stepId === expected.stepId)
    )
      return
    await new Promise((resolve) => setTimeout(resolve, 60))
  }
  throw new Error('状态目录未能在崩溃点前稳定复制')
}

/** 等待发布是独立持久边界：复制要求状态、交互和检查点已是同一条记录。 */
async function snapshotWaitingState(
  source: string,
  destination: string,
  scope: ScopeLike,
  kind: string
): Promise<void> {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const execution = await copyStableState(source, destination, scope)
    if (
      execution.state === 'waiting' &&
      execution.interaction?.kind === kind &&
      execution.checkpointId !== undefined
    )
      return
    await new Promise((resolve) => setTimeout(resolve, 60))
  }
  throw new Error('等待状态未能在发布边界稳定复制')
}

/** 在等待进度写入后立即终止；下一次重开只能依赖这条完整等待记录。 */
function installWaitingPublishFence(input: {
  app: SceneGenerationServices
  base: GenerationFixture
  scope: ScopeLike
  snapshotRoot: string
  kind: string
}): void {
  const original = input.app.ports.executions.writeExecution.bind(input.app.ports.executions)
  let captured = false
  vi.spyOn(input.app.ports.executions, 'writeExecution').mockImplementation(async (execution) => {
    const recorded = await original(execution)
    if (!captured && recorded.state === 'waiting' && recorded.interaction?.kind === input.kind) {
      captured = true
      await snapshotWaitingState(
        input.base.config.userStateRoot,
        input.snapshotRoot,
        input.scope,
        input.kind
      )
      throw new Error('fault fence: process terminated after waiting publication')
    }
    return recorded
  })
}

/**
 * 从公开装配的端口给候选修订保存注入栅栏：在 save 前或 save 后复制原现场并终止。
 * 不预置 candidateSnapshotId，也不依赖完成回执；record 由工作流在 save 返回后执行。
 */
function installSaveFence(input: {
  app: SceneGenerationServices
  base: GenerationFixture
  scope: ScopeLike
  snapshotRoot: string
  saveNumber: number
  when: 'before' | 'after'
  expectedStepId?: string
}): void {
  const original = input.app.ports.artifacts.saveCandidateRevision.bind(input.app.ports.artifacts)
  let saves = 0
  vi.spyOn(input.app.ports.artifacts, 'saveCandidateRevision').mockImplementation(
    async (execution) => {
      saves += 1
      if (saves !== input.saveNumber) return original(execution)
      if (input.when === 'before') {
        await snapshotUserState(input.base.config.userStateRoot, input.snapshotRoot, input.scope, {
          ...(input.expectedStepId === undefined ? {} : { stepId: input.expectedStepId })
        })
        throw new Error('fault fence: process terminated before candidate revision save')
      }
      await original(execution)
      await snapshotUserState(input.base.config.userStateRoot, input.snapshotRoot, input.scope, {
        ...(input.expectedStepId === undefined ? {} : { stepId: input.expectedStepId })
      })
      throw new Error('fault fence: process terminated before candidate revision record')
    }
  )
}

type ReadingBoundary = {
  app: SceneGenerationServices
  scope: ScopeLike
  execution: SceneGenerationExecution
}

async function createReadingBoundary(base: GenerationFixture): Promise<ReadingBoundary> {
  const calls = { count: 0 }
  const app = await appWithModel(base, writeThenStopModel(calls))
  const operation = await app.generation.generateScene(request)
  const scope = scopeOf(operation)
  const interrupted = vi
    .spyOn(app.ports.artifacts, 'readCandidate')
    .mockRejectedValueOnce(new Error('candidate read interrupted after reading checkpoint'))
  await expect(runQueued(base)).rejects.toThrow()
  interrupted.mockRestore()
  const execution = (await app.ports.executions.readExecution(request))!
  expect(execution.state).toBe('interrupted')
  expect(execution.interruptReason).toBe('readInterrupted')
  expect(execution.step).toBe('reading')
  expect(execution.candidateSnapshotId).toMatch(/^[0-9a-f]{40}$/u)
  expect(execution.checkpointId).toBe(
    `pi-review-${scope.operationId}-${execution.candidateSnapshotId}`
  )
  const effects = await effectRecords(base.config.userStateRoot, scope)
  expect(effects).toContainEqual(
    expect.objectContaining({
      stepId: 'generate-0',
      status: 'completed',
      candidateRevision: execution.candidateSnapshotId
    })
  )
  return { app, scope, execution }
}

async function rewriteEffect(
  userStateRoot: string,
  scope: ScopeLike,
  stepId: string,
  patch: Partial<CandidateEffect>
): Promise<void> {
  const path = await effectFile(userStateRoot, scope, stepId)
  const current = JSON.parse(await readFile(path, 'utf8')) as CandidateEffect
  await writeFile(path, `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`)
}

async function officialFacts(base: GenerationFixture): Promise<{ entry: string; head: string }> {
  return {
    entry: await readFile(join(base.projectRoot, 'game/scene/start.txt'), 'utf8'),
    head: base.git('rev-parse', 'HEAD')
  }
}

function workspaceDirectory(userStateRoot: string, scope: ScopeLike): string {
  return join(
    userStateRoot,
    'ai',
    'projects',
    scope.projectId,
    'threads',
    scope.threadId,
    'workspaces',
    scope.operationId
  )
}

function workspaceEntry(userStateRoot: string, scope: ScopeLike): string {
  return join(workspaceDirectory(userStateRoot, scope), 'game/scene/start.txt')
}

function scopeOf(execution: {
  projectId: string
  sceneId: string
  threadId: string
  operationId: string
}): ScopeLike {
  return {
    projectId: execution.projectId,
    sceneId: execution.sceneId,
    threadId: execution.threadId,
    operationId: execution.operationId
  }
}

it('[B1] 写入已确认、工具回执丢失：写回真实候选并进入审阅，不落成 failed', async () => {
  const base = await generationFixture()
  const official = await officialFacts(base)
  faults.fileWrite = 'after'
  const calls = { count: 0 }
  const fetcher = streamingFetch(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: ModelMessage[] }
    const last = body.messages.at(-1)
    calls.count += 1
    return last?.role === 'tool'
      ? stopResponse()
      : toolCallResponse(body.messages, validScript, `w-${calls.count}`)
  })
  const app = await appWithModel(base, fetcher)
  await app.generation.generateScene(request)
  await runQueuedIgnoringFailure(base)
  faults.fileWrite = 'none'

  const execution = (await app.ports.executions.readExecution(request))!
  const effects = await effectRecords(base.config.userStateRoot, scopeOf(execution))
  expect(execution.state).toBe('waiting')
  expect(execution.interaction?.kind).toBe('review')
  expect(execution.artifactValidation?.issues).toEqual([])
  const candidate = await app.ports.artifacts.readCandidate(
    execution,
    execution.candidateSnapshotId!
  )
  expect(candidate.preview.validationReport.issues).toEqual([])
  const status = await app.status.getSceneGenerationStatus(request)
  expect(status.state).toBe('waiting')
  expect(status.interaction?.kind).toBe('review')
  expect(status.canResume).toBe(false)
  expect(effects).toHaveLength(1)
  expect(effects[0]).toMatchObject({
    stepId: 'generate-0',
    status: 'completed',
    candidateRevision: execution.candidateSnapshotId
  })
  expect(effects[0]?.resultDigest).toBeTruthy()
  expect(calls.count).toBe(2)
  expect(
    await readFile(workspaceEntry(base.config.userStateRoot, scopeOf(execution)), 'utf8')
  ).toBe(validScript)
  expect(await officialFacts(base)).toEqual(official)
})

it('[B2] 工具回执失败但宿主已记录写入事实：直接校验并进入审阅', async () => {
  const base = await generationFixture()
  const official = await officialFacts(base)
  faults.loseReceipt = true
  const calls = { count: 0 }
  const fetcher = streamingFetch(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: ModelMessage[] }
    const last = body.messages.at(-1)
    calls.count += 1
    return last?.role === 'tool'
      ? stopResponse()
      : toolCallResponse(body.messages, validScript, `w-${calls.count}`)
  })
  const app = await appWithModel(base, fetcher)
  await app.generation.generateScene(request)
  await runQueued(base)
  faults.loseReceipt = false

  const execution = (await app.ports.executions.readExecution(request))!
  const effects = await effectRecords(base.config.userStateRoot, scopeOf(execution))
  expect(execution.state).toBe('waiting')
  expect(execution.interaction?.kind).toBe('review')
  expect(execution.artifactValidation?.issues).toEqual([])
  expect(effects).toContainEqual(
    expect.objectContaining({ stepId: 'generate-0', status: 'completed' })
  )
  expect(await officialFacts(base)).toEqual(official)
})

it('[B3] 第二轮模型失败保留上一轮已校验候选与真实报告，停在修正等待', async () => {
  const base = await generationFixture()
  const official = await officialFacts(base)
  const calls = { count: 0 }
  const turns = { count: 0 }
  const app = await appWithModel(base, writeInvalidThenFailModel({ calls, turns }))
  await app.generation.generateScene(request)
  await runQueuedIgnoringFailure(base)

  const execution = (await app.ports.executions.readExecution(request))!
  const effects = await effectRecords(base.config.userStateRoot, scopeOf(execution))
  expect(execution.state).toBe('waiting')
  expect(execution.interaction?.kind).toBe('correction')
  expect(execution.interaction?.allowedReplies).toEqual(['revise', 'discard'])
  expect(execution.artifactValidation?.issues.length).toBeGreaterThan(0)
  const candidate = await app.ports.artifacts.readCandidate(
    execution,
    execution.candidateSnapshotId!
  )
  expect(candidate.preview.validationReport.issues.length).toBeGreaterThan(0)
  expect(effects).toContainEqual(
    expect.objectContaining({
      stepId: 'generate-0',
      status: 'completed',
      candidateRevision: execution.candidateSnapshotId
    })
  )
  const status = await app.status.getSceneGenerationStatus(request)
  expect(status.state).toBe('waiting')
  expect(status.interaction?.kind).toBe('correction')
  const checkpoint = await app.ports.history.readCheckpoint({
    projectId: execution.projectId,
    sceneId: execution.sceneId,
    threadId: execution.threadId,
    branchId: execution.branchId,
    checkpointId: execution.checkpointId!
  })
  expect(checkpoint.view.summary).toBe('候选需要修正，等待作者说明')
  expect(checkpoint.view.canReply).toBe(true)
  expect(checkpoint.view.canContinue).toBe(false)
  expect(calls.count).toBe(2)
  expect(
    await readFile(workspaceEntry(base.config.userStateRoot, scopeOf(execution)), 'utf8')
  ).toContain('missing.svg')
  expect(await officialFacts(base)).toEqual(official)
})

it('[取消] 第二轮模型请求中作者取消：保持 cancelled，不冒充待恢复', async () => {
  const base = await generationFixture()
  const official = await officialFacts(base)
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const calls = { count: 0 }
  const turns = { count: 0 }
  const fetcher = streamingFetch(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: ModelMessage[] }
    const last = body.messages.at(-1)
    calls.count += 1
    if (last?.role === 'user') {
      turns.count += 1
      if (turns.count === 1)
        return toolCallResponse(
          body.messages,
          validScript.replace('station.svg', 'missing.svg'),
          'w-1'
        )
      started.resolve()
      await release.promise
    }
    return stopResponse()
  })
  const app = await appWithModel(base, fetcher)
  const operation = await app.generation.generateScene(request)
  const running = (async () => {
    const job = base.jobs.shift()
    await job!()
  })()
  await started.promise
  await app.control.cancelSceneGeneration(request)
  release.resolve()
  await running

  const execution = (await app.ports.executions.readExecution(request))!
  const effects = await effectRecords(base.config.userStateRoot, scopeOf(operation))
  const status = await app.status.getSceneGenerationStatus(request)
  expect(execution.state).toBe('cancelled')
  expect(execution.interaction).toBeUndefined()
  expect(status.state).toBe('cancelled')
  expect(status.canResume).toBe(false)
  expect(effects).toContainEqual(
    expect.objectContaining({ stepId: 'generate-0', status: 'completed' })
  )
  expect(calls.count).toBe(2)
  expect(await officialFacts(base)).toEqual(official)
})

async function crashStateAfterRevision(
  base: GenerationFixture,
  dto: GenerateSceneDTO = request
): Promise<{ snapshotRoot: string; scope: ScopeLike; candidateSnapshotId: string }> {
  const work = await mkdtemp(join(tmpdir(), 'write-recovery-snapshot-'))
  extraRoots.push(work)
  const snapshotRoot = join(work, 'state')
  const calls = { count: 0 }
  const app = await appWithModel(base, writeThenStopModel(calls))
  const operation = await app.generation.generateScene(dto)
  const scope = scopeOf(operation)
  faults.completedEffectFence = async ({ identity }) => {
    if (identity.operationId !== scope.operationId) return
    await snapshotUserState(base.config.userStateRoot, snapshotRoot, scope)
  }
  await expect(runQueued(base)).rejects.toMatchObject({ code: 4103 })
  faults.completedEffectFence = null
  const original = (await app.ports.executions.readExecution(dto))!
  return {
    snapshotRoot,
    scope,
    candidateSnapshotId: original.candidateSnapshotId!
  }
}

it('[C] 重开先按 started 账本与修订归属结算，再进入审阅；重开两次只补一次', async () => {
  const base = await generationFixture()
  const official = await officialFacts(base)
  const { snapshotRoot, scope, candidateSnapshotId } = await crashStateAfterRevision(base)
  const startedEffect = (await effectRecords(snapshotRoot, scope)).find(
    (item) => item.stepId === 'generate-0'
  )
  expect(startedEffect).toMatchObject({
    operationId: scope.operationId,
    stepId: 'generate-0',
    status: 'started',
    kind: 'fileWrite'
  })
  expect(startedEffect?.resultDigest).toBeUndefined()
  expect(startedEffect?.candidateRevision).toBeUndefined()
  faults.completedWrites = []

  const recoveryCalls = { count: 0 }
  const reopened = await reopen(base, snapshotRoot, failModel(recoveryCalls))
  expect(
    await reopened.app.ports.artifacts.readCandidate(
      (await reopened.app.ports.executions.readExecution(request))!,
      candidateSnapshotId
    )
  ).toMatchObject({ candidateSnapshotId })
  await reopened.app.generation.resumeSceneGeneration(request)
  await reopened.run()

  const execution = (await reopened.app.ports.executions.readExecution(request))!
  const effects = await effectRecords(snapshotRoot, scope)
  expect(execution.state).toBe('waiting')
  expect(execution.interaction?.kind).toBe('review')
  expect(execution.artifactValidation?.issues).toEqual([])
  expect(execution.candidateSnapshotId).toBe(candidateSnapshotId)
  expect(effects).toHaveLength(1)
  expect(effects[0]).toMatchObject({
    stepId: 'generate-0',
    inputDigest: startedEffect?.inputDigest,
    status: 'completed',
    candidateRevision: candidateSnapshotId,
    resultDigest: candidateSnapshotId
  })
  expect(recoveryCalls.count).toBe(0)
  expect(faults.completedWrites.filter((item) => item.stepId === 'generate-0')).toHaveLength(1)
  expect(await readFile(workspaceEntry(snapshotRoot, scope), 'utf8')).toBe(validScript)
  expect(await officialFacts(base)).toEqual(official)
  const status = await reopened.app.status.getSceneGenerationStatus(request)
  expect(status.state).toBe('waiting')
  expect(status.interaction?.kind).toBe('review')
  expect(status.canResume).toBe(false)

  const again = await reopen(base, snapshotRoot, failModel(recoveryCalls))
  const againStatus = await again.app.status.getSceneGenerationStatus(request)
  expect(againStatus.state).toBe('waiting')
  const replay = await again.app.generation.resumeSceneGeneration(request)
  expect(replay.state).toBe('waiting')
  expect(again.jobs).toHaveLength(0)
  const effectsAgain = await effectRecords(snapshotRoot, scope)
  expect(effectsAgain).toEqual(effects)
  expect(faults.completedWrites.filter((item) => item.stepId === 'generate-0')).toHaveLength(1)
  expect(recoveryCalls.count).toBe(0)
  expect(await readFile(workspaceEntry(snapshotRoot, scope), 'utf8')).toBe(validScript)
  expect(await officialFacts(base)).toEqual(official)
}, 30000)

async function expectWriteUnknown(input: {
  base: GenerationFixture
  snapshotRoot: string
  scope: ScopeLike
  official: { entry: string; head: string }
  expectedCandidate: string
  expectedStepId?: string
  expectedInputDigest?: string
}): Promise<void> {
  const calls = { count: 0 }
  const reopened = await reopen(input.base, input.snapshotRoot, failModel(calls))
  await reopened.app.generation.resumeSceneGeneration(request).catch(() => undefined)
  await reopened.run().catch(() => undefined)
  const after = (await reopened.app.ports.executions.readExecution(request))!
  const effects = await effectRecords(input.snapshotRoot, input.scope)
  expect(after.state).toBe('interrupted')
  expect(after.interruptReason).toBe('writeUnknown')
  expect(after.step).toBeUndefined()
  expect(after.interaction).toBeUndefined()
  expect(after.requiresCleanup).not.toBe(true)
  expect(after.candidateSnapshotId).toBe(input.expectedCandidate)
  expect((await stat(workspaceDirectory(input.snapshotRoot, input.scope))).isDirectory()).toBe(true)
  expect(await readFile(workspaceEntry(input.snapshotRoot, input.scope), 'utf8')).toBe(validScript)
  expect(effects).toHaveLength(1)
  expect(effects[0]).toMatchObject({
    status: 'started',
    ...(input.expectedStepId === undefined ? {} : { stepId: input.expectedStepId }),
    ...(input.expectedInputDigest === undefined ? {} : { inputDigest: input.expectedInputDigest })
  })
  const status = await reopened.app.status.getSceneGenerationStatus(request)
  expect(status.state).toBe('interrupted')
  expect(status.failure?.message).toContain('待核对')
  expect(status.interaction).toBeUndefined()
  expect(calls.count).toBe(0)
  expect(await officialFacts(input.base)).toEqual(input.official)
  await expect(reopened.app.generation.resumeSceneGeneration(request)).rejects.toMatchObject({
    code: 4103
  })
  expect(calls.count).toBe(0)
  expect(await effectRecords(input.snapshotRoot, input.scope)).toEqual(effects)
}

it('[归属] 读取边界里别的 operationId 的 started 回执不能证明本操作写入', async () => {
  const base = await generationFixture()
  const official = await officialFacts(base)
  const crash = await crashStateAfterRevision(base)
  const started = (await effectRecords(crash.snapshotRoot, crash.scope))[0]
  await rewriteEffect(crash.snapshotRoot, crash.scope, 'generate-0', {
    operationId: 'operation-foreign'
  })
  await expectWriteUnknown({
    base,
    snapshotRoot: crash.snapshotRoot,
    scope: crash.scope,
    official,
    expectedCandidate: crash.candidateSnapshotId,
    expectedStepId: 'generate-0',
    expectedInputDigest: started?.inputDigest
  })
}, 30000)

it('[输入] 读取边界里 inputDigest 不匹配的 started 回执不能证明本次写入', async () => {
  const base = await generationFixture()
  const official = await officialFacts(base)
  const crash = await crashStateAfterRevision(base)
  await rewriteEffect(crash.snapshotRoot, crash.scope, 'generate-0', {
    inputDigest: 'f'.repeat(64)
  })
  await expectWriteUnknown({
    base,
    snapshotRoot: crash.snapshotRoot,
    scope: crash.scope,
    official,
    expectedCandidate: crash.candidateSnapshotId,
    expectedStepId: 'generate-0',
    expectedInputDigest: 'f'.repeat(64)
  })
}, 30000)

it('[归属] 读取边界里 stepId 不匹配的 started 回执不能证明本步写入', async () => {
  const base = await generationFixture()
  const official = await officialFacts(base)
  const crash = await crashStateAfterRevision(base)
  await rewriteEffect(crash.snapshotRoot, crash.scope, 'generate-0', {
    stepId: 'repair-0'
  })
  await expectWriteUnknown({
    base,
    snapshotRoot: crash.snapshotRoot,
    scope: crash.scope,
    official,
    expectedCandidate: crash.candidateSnapshotId,
    expectedStepId: 'repair-0'
  })
}, 30000)

it('[归属] 恢复不能把同一线程另一操作的真实修订当成自己的候选', async () => {
  const base = await generationFixture()
  const official = await officialFacts(base)
  const calls = { count: 0 }
  const app = await appWithModel(base, writeThenStopModel(calls))
  const aDto: GenerateSceneDTO = { ...request, operationId: 'operation-a' }
  await app.generation.generateScene(aDto)
  await runQueued(base)
  const aExecution = (await app.ports.executions.readExecution(aDto))!
  const aStatus = await app.status.getSceneGenerationStatus(aDto)
  expect(aStatus.state).toBe('waiting')
  const aCandidate = aExecution.candidateSnapshotId!
  await app.generation.replySceneGenerationInteraction({
    projectId: aExecution.projectId,
    sceneId: aExecution.sceneId,
    operationId: aExecution.operationId,
    threadId: aExecution.threadId,
    branchId: aExecution.branchId,
    interactionId: aStatus.interaction!.interactionId,
    checkpointId: aStatus.interaction!.checkpointId,
    candidateSnapshotId: aStatus.interaction!.candidateSnapshotId,
    replyId: 'discard-a',
    reply: { kind: 'discard' }
  })
  await runQueued(base)
  expect((await app.ports.executions.readExecution(aDto))!.state).toBe('cancelled')

  const bDto: GenerateSceneDTO = {
    ...request,
    operationId: 'operation-b',
    branch: { threadId: aExecution.threadId, branchId: 'branch-b' }
  }
  const crash = await crashStateAfterRevision(base, bDto)
  const recoveryCalls = { count: 0 }
  const reopened = await reopen(base, crash.snapshotRoot, failModel(recoveryCalls))
  const bStored = (await reopened.app.ports.executions.readExecution(bDto))!
  await reopened.app.ports.executions.writeExecution({
    ...bStored,
    candidateSnapshotId: aCandidate
  })

  await reopened.app.generation.resumeSceneGeneration(bDto).catch(() => undefined)
  await reopened.run().catch(() => undefined)
  const after = (await reopened.app.ports.executions.readExecution(bDto))!
  const effects = await effectRecords(crash.snapshotRoot, crash.scope)
  expect(after.state).toBe('interrupted')
  expect(after.interruptReason).toBe('writeUnknown')
  expect(after.candidateSnapshotId).not.toBe(aCandidate)
  expect(after.candidateSnapshotId).toBe(crash.candidateSnapshotId)
  expect(effects).toHaveLength(1)
  expect(effects[0]).toMatchObject({ stepId: 'generate-0', status: 'started' })
  expect(recoveryCalls.count).toBe(0)
  expect(await readFile(workspaceEntry(crash.snapshotRoot, crash.scope), 'utf8')).toBe(validScript)
  expect(await officialFacts(base)).toEqual(official)
  const revisionGitDir = join(
    crash.snapshotRoot,
    'ai',
    'projects',
    crash.scope.projectId,
    'threads',
    crash.scope.threadId,
    'revisions'
  )
  const aCommit = await git.readCommit({ fs, gitdir: revisionGitDir, oid: aCandidate })
  expect(
    aCommit.commit.message.split(/\r?\n/u).find((line) => line.startsWith('Operation-Id:'))
  ).toBe('Operation-Id: operation-a')
}, 30000)

it('[不可证实] started 写入但候选修订引用缺失：保留工作区与账本待核对', async () => {
  const base = await generationFixture()
  const official = await officialFacts(base)
  const crash = await crashStateAfterRevision(base)
  const refPath = join(
    crash.snapshotRoot,
    'ai',
    'projects',
    crash.scope.projectId,
    'threads',
    crash.scope.threadId,
    'revisions',
    'refs',
    'opengalgame',
    'revisions',
    crash.candidateSnapshotId
  )
  expect(
    await stat(refPath).then(
      () => true,
      () => false
    )
  ).toBe(true)
  await rm(refPath, { force: true })
  await expectWriteUnknown({
    base,
    snapshotRoot: crash.snapshotRoot,
    scope: crash.scope,
    official,
    expectedCandidate: crash.candidateSnapshotId,
    expectedStepId: 'generate-0'
  })
}, 30000)

it('[读取] 写后读取中断通过公开恢复入口重读候选，不重新调用模型', async () => {
  const base = await generationFixture()
  const official = await officialFacts(base)
  const boundary = await createReadingBoundary(base)
  const calls = { count: 0 }
  const reopened = await reopen(base, base.config.userStateRoot, failModel(calls))
  await reopened.app.generation.resumeSceneGeneration(request)
  await reopened.run()

  const execution = (await reopened.app.ports.executions.readExecution(request))!
  const effects = await effectRecords(base.config.userStateRoot, boundary.scope)
  expect(execution.state).toBe('waiting')
  expect(execution.interaction?.kind).toBe('review')
  expect(execution.artifactValidation?.issues).toEqual([])
  expect(execution.candidateSnapshotId).toBe(boundary.execution.candidateSnapshotId)
  // 读取成功后中断事实必须被消费：状态、详情、历史和允许动作都不能继续声称正在重读。
  expect(execution.interruptReason).toBeUndefined()
  expect(execution.failure).toBeUndefined()
  expect(execution.step).toBeUndefined()
  expect(effects).toContainEqual(
    expect.objectContaining({
      stepId: 'generate-0',
      status: 'completed',
      candidateRevision: execution.candidateSnapshotId
    })
  )
  expect(calls.count).toBe(0)
  expect(
    await readFile(workspaceEntry(base.config.userStateRoot, scopeOf(execution)), 'utf8')
  ).toBe(validScript)
  expect(await officialFacts(base)).toEqual(official)
  const status = await reopened.app.status.getSceneGenerationStatus(request)
  expect(status.state).toBe('waiting')
  expect(status.interaction?.kind).toBe('review')
  expect(status.failure).toBeUndefined()
  expect(status.canResume).toBe(false)
  expect(toRenderStatusVO(execution).stageMessage).toBe('候选已就绪，等待你的决定')
  const checkpoint = await reopened.app.ports.history.readCheckpoint({
    projectId: execution.projectId,
    sceneId: execution.sceneId,
    threadId: execution.threadId,
    branchId: execution.branchId,
    checkpointId: execution.checkpointId!
  })
  expect(checkpoint.view.summary).toBe('候选已发布，等待审阅')
  expect(checkpoint.view.canContinue).toBe(false)
  expect(checkpoint.view.canReply).toBe(true)
  expect(checkpoint.view.reason).not.toContain('重读')
}, 30000)

it('[C-1] 首次写入开始但修订尚未保存：保留原工作区与 started 账本待核对', async () => {
  const base = await generationFixture()
  const official = await officialFacts(base)
  const calls = { count: 0 }
  const app = await appWithModel(base, writeThenStopModel(calls))
  const operation = await app.generation.generateScene(request)
  const scope = scopeOf(operation)
  const snapshotRoot = await newSnapshotRoot('write-recovery-first-before-')
  installSaveFence({
    app,
    base,
    scope,
    snapshotRoot,
    saveNumber: 1,
    when: 'before',
    expectedStepId: 'generate-0'
  })
  await runQueuedIgnoringFailure(base)

  const recoveryCalls = { count: 0 }
  const reopened = await reopen(base, snapshotRoot, failModel(recoveryCalls))
  const stored = (await reopened.app.ports.executions.readExecution(request))!
  expect(stored.state).toBe('running')
  expect(stored.candidateSnapshotId).toBeUndefined()
  expect(stored.checkpointId).toBeUndefined()
  const atCrash = await effectRecords(snapshotRoot, scope)
  expect(atCrash).toHaveLength(1)
  expect(atCrash[0]).toMatchObject({ stepId: 'generate-0', status: 'started' })
  expect(atCrash[0]).not.toHaveProperty('candidateRevision')

  await reopened.app.generation.resumeSceneGeneration(request)
  await reopened.run()

  const after = (await reopened.app.ports.executions.readExecution(request))!
  expect(after.state).toBe('interrupted')
  expect(after.interruptReason).toBe('writeUnknown')
  expect(after.candidateSnapshotId).toBeUndefined()
  expect(after.interaction).toBeUndefined()
  expect(after.failure?.message).toContain('待核对')
  expect(await effectRecords(snapshotRoot, scope)).toEqual(atCrash)
  expect(await readFile(workspaceEntry(snapshotRoot, scope), 'utf8')).toBe(validScript)
  expect(await officialFacts(base)).toEqual(official)
  expect(recoveryCalls.count).toBe(0)
  expect(faults.completedWrites).toHaveLength(0)
  const status = await reopened.app.status.getSceneGenerationStatus(request)
  expect(status.state).toBe('interrupted')
  expect(status.interaction).toBeUndefined()
  expect(status.failure?.message).toContain('待核对')
  await expect(reopened.app.generation.resumeSceneGeneration(request)).rejects.toMatchObject({
    code: 4103
  })
}, 30000)

it('[C-1] 首次写入修订已保存但候选未记录：先绑定修订再补结算并审阅', async () => {
  const base = await generationFixture()
  const official = await officialFacts(base)
  const calls = { count: 0 }
  const app = await appWithModel(base, writeThenStopModel(calls))
  const operation = await app.generation.generateScene(request)
  const scope = scopeOf(operation)
  const snapshotRoot = await newSnapshotRoot('write-recovery-first-after-')
  installSaveFence({
    app,
    base,
    scope,
    snapshotRoot,
    saveNumber: 1,
    when: 'after',
    expectedStepId: 'generate-0'
  })
  await runQueuedIgnoringFailure(base)

  const recoveryCalls = { count: 0 }
  const reopened = await reopen(base, snapshotRoot, failModel(recoveryCalls))
  const stored = (await reopened.app.ports.executions.readExecution(request))!
  expect(stored.state).toBe('running')
  expect(stored.candidateSnapshotId).toBeUndefined()
  expect(stored.checkpointId).toBeUndefined()
  expect((await effectRecords(snapshotRoot, scope))[0]).toMatchObject({
    stepId: 'generate-0',
    status: 'started'
  })
  faults.completedWrites = []

  await reopened.app.generation.resumeSceneGeneration(request)
  await reopened.run()

  const execution = (await reopened.app.ports.executions.readExecution(request))!
  expect(execution.state).toBe('waiting')
  expect(execution.interaction?.kind).toBe('review')
  expect(execution.artifactValidation?.issues).toEqual([])
  expect(execution.candidateSnapshotId).toMatch(/^[0-9a-f]{40}$/u)
  expect(execution.interruptReason).toBeUndefined()
  expect(execution.checkpointId).toBe(
    piReviewCheckpointId(execution.operationId, execution.candidateSnapshotId)
  )
  const effects = await effectRecords(snapshotRoot, scope)
  expect(effects).toHaveLength(1)
  expect(effects[0]).toMatchObject({
    stepId: 'generate-0',
    status: 'completed',
    candidateRevision: execution.candidateSnapshotId
  })
  expect(faults.completedWrites.filter((item) => item.stepId === 'generate-0')).toHaveLength(1)
  expect(recoveryCalls.count).toBe(0)
  expect(await readFile(workspaceEntry(snapshotRoot, scope), 'utf8')).toBe(validScript)
  expect(await officialFacts(base)).toEqual(official)
  const status = await reopened.app.status.getSceneGenerationStatus(request)
  expect(status.state).toBe('waiting')
  expect(status.interaction?.kind).toBe('review')
  expect(status.interaction?.allowedReplies).toEqual(['accept', 'revise', 'discard'])
  const checkpoint = await reopened.app.ports.history.readCheckpoint({
    projectId: execution.projectId,
    sceneId: execution.sceneId,
    threadId: execution.threadId,
    branchId: execution.branchId,
    checkpointId: execution.checkpointId!
  })
  expect(checkpoint.view.summary).toBe('候选已发布，等待审阅')
  expect(checkpoint.view.canContinue).toBe(false)
}, 30000)

it('[C-2] 第二次写入修订已保存但候选未记录：父链证明、同一结算只补一次，再重开审阅', async () => {
  const base = await generationFixture()
  const official = await officialFacts(base)
  const calls = { count: 0 }
  const app = await appWithModel(base, writeTwiceThenStopModel(calls))
  const operation = await app.generation.generateScene(request)
  const scope = scopeOf(operation)
  const snapshotRoot = await newSnapshotRoot('write-recovery-second-after-')
  installSaveFence({
    app,
    base,
    scope,
    snapshotRoot,
    saveNumber: 2,
    when: 'after',
    expectedStepId: 'repair-1'
  })
  await runQueuedIgnoringFailure(base)

  const recoveryCalls = { count: 0 }
  const reopened = await reopen(base, snapshotRoot, failModel(recoveryCalls))
  const stored = (await reopened.app.ports.executions.readExecution(request))!
  expect(stored.state).toBe('running')
  expect(stored.candidateSnapshotId).toMatch(/^[0-9a-f]{40}$/u)
  // 第一轮写入已发布 reading 边界，检查点仍指向写前候选；恢复必须照样读旧账本。
  expect(stored.checkpointId).toBe(
    piReviewCheckpointId(stored.operationId, stored.candidateSnapshotId)
  )
  const atCrash = await effectRecords(snapshotRoot, scope)
  expect(atCrash).toContainEqual(
    expect.objectContaining({
      stepId: 'generate-0',
      status: 'completed',
      candidateRevision: stored.candidateSnapshotId
    })
  )
  expect(atCrash).toContainEqual(expect.objectContaining({ stepId: 'repair-1', status: 'started' }))
  faults.completedWrites = []

  let boundBeforeSettlement: string | undefined
  const first = await reopened.app.ports.writeRecovery.recoverCandidateWrite(
    stored,
    async (candidateSnapshotId) => {
      boundBeforeSettlement = candidateSnapshotId
      const current = (await reopened.app.ports.executions.readExecution(request))!
      await reopened.app.ports.executions.writeExecution({
        ...current,
        candidateSnapshotId,
        sequence: current.sequence + 1
      })
    }
  )
  if (first.outcome !== 'proven') throw new Error(`首次结算未证明：${first.outcome}`)
  expect(boundBeforeSettlement).toBe(first.candidateSnapshotId)
  expect(first.settled).toBe(true)
  expect(first.checkpointSuperseded).toBe(true)
  expect(first.candidateSnapshotId).not.toBe(stored.candidateSnapshotId)
  const second = await reopened.app.ports.writeRecovery.recoverCandidateWrite(
    stored,
    async () => {}
  )
  if (second.outcome !== 'proven') throw new Error(`第二次结算未证明：${second.outcome}`)
  expect(second.candidateSnapshotId).toBe(first.candidateSnapshotId)
  expect(second.settled).toBe(false)
  expect(faults.completedWrites.filter((item) => item.stepId === 'repair-1')).toHaveLength(1)

  await reopened.app.generation.resumeSceneGeneration(request)
  await reopened.run()

  const execution = (await reopened.app.ports.executions.readExecution(request))!
  expect(execution.state).toBe('waiting')
  expect(execution.interaction?.kind).toBe('review')
  expect(execution.candidateSnapshotId).toBe(first.candidateSnapshotId)
  expect(execution.artifactValidation?.issues).toEqual([])
  expect(execution.interruptReason).toBeUndefined()
  const effects = await effectRecords(snapshotRoot, scope)
  expect(effects).toContainEqual(
    expect.objectContaining({
      stepId: 'repair-1',
      status: 'completed',
      candidateRevision: first.candidateSnapshotId
    })
  )
  expect(faults.completedWrites.filter((item) => item.stepId === 'repair-1')).toHaveLength(1)
  expect(recoveryCalls.count).toBe(0)
  expect(await readFile(workspaceEntry(snapshotRoot, scope), 'utf8')).toBe(validScript)
  expect(await officialFacts(base)).toEqual(official)
}, 30000)

it('[C-2] 输入实际改变后恢复：不把旧写入当成本次结果，保留工作区与账本待核对', async () => {
  const base = await generationFixture()
  const official = await officialFacts(base)
  const calls = { count: 0 }
  const app = await appWithModel(base, writeTwiceThenStopModel(calls))
  const operation = await app.generation.generateScene(request)
  const scope = scopeOf(operation)
  const snapshotRoot = await newSnapshotRoot('write-recovery-input-changed-')
  installSaveFence({
    app,
    base,
    scope,
    snapshotRoot,
    saveNumber: 2,
    when: 'after',
    expectedStepId: 'repair-1'
  })
  await runQueuedIgnoringFailure(base)

  const recoveryCalls = { count: 0 }
  const reopened = await reopen(base, snapshotRoot, failModel(recoveryCalls))
  const stored = (await reopened.app.ports.executions.readExecution(request))!
  const atCrash = await effectRecords(snapshotRoot, scope)
  await reopened.app.ports.executions.writeExecution({
    ...stored,
    inputSnapshot: { ...stored.inputSnapshot, canvasId: 'canvas-2' }
  })
  faults.completedWrites = []

  await reopened.app.generation.resumeSceneGeneration(request)
  await reopened.run()

  const after = (await reopened.app.ports.executions.readExecution(request))!
  expect(after.state).toBe('interrupted')
  expect(after.interruptReason).toBe('writeUnknown')
  expect(after.interaction).toBeUndefined()
  expect(after.failure?.message).toContain('待核对')
  expect(await effectRecords(snapshotRoot, scope)).toEqual(atCrash)
  expect(faults.completedWrites).toHaveLength(0)
  expect(recoveryCalls.count).toBe(0)
  expect(await readFile(workspaceEntry(snapshotRoot, scope), 'utf8')).toBe(validScript)
  expect(await officialFacts(base)).toEqual(official)
  const status = await reopened.app.status.getSceneGenerationStatus(request)
  expect(status.state).toBe('interrupted')
  expect(status.interaction).toBeUndefined()
}, 30000)

it('[C-4] 回复修改后写入已保存、候选未记录：暂停边界失效后按新候选审阅', async () => {
  const base = await generationFixture()
  const official = await officialFacts(base)
  const calls = { count: 0 }
  const app = await appWithModel(base, writeThenStopModel(calls))
  await app.generation.generateScene(request)
  await runQueued(base)
  const reviewed = (await app.ports.executions.readExecution(request))!
  expect(reviewed.state).toBe('waiting')
  expect(reviewed.interaction?.kind).toBe('review')
  const firstCandidate = reviewed.candidateSnapshotId!
  const tag = candidateReplyStepTag('revise-crash')
  const reviseStep = `repair-0-${tag}`
  const snapshotRoot = await newSnapshotRoot('write-recovery-reply-after-')
  installSaveFence({
    app,
    base,
    scope: scopeOf(reviewed),
    snapshotRoot,
    saveNumber: 1,
    when: 'after',
    expectedStepId: reviseStep
  })
  await replyRevise(app, reviewed, 'revise-crash', '把结尾改得更克制')
  await runQueuedIgnoringFailure(base)

  const recoveryCalls = { count: 0 }
  const reopened = await reopen(base, snapshotRoot, failModel(recoveryCalls))
  const stored = (await reopened.app.ports.executions.readExecution(request))!
  expect(stored.state).toBe('running')
  expect(stored.candidateSnapshotId).toBe(firstCandidate)
  expect(stored.pendingReply?.reply.kind).toBe('revise')
  expect(stored.checkpointId).toBe(piReviewCheckpointId(stored.operationId, firstCandidate))
  expect(await effectRecords(snapshotRoot, scopeOf(stored))).toContainEqual(
    expect.objectContaining({ stepId: reviseStep, status: 'started' })
  )
  faults.completedWrites = []

  await reopened.app.generation.resumeSceneGeneration(request)
  await reopened.run()

  const execution = (await reopened.app.ports.executions.readExecution(request))!
  expect(execution.state).toBe('waiting')
  expect(execution.interaction?.kind).toBe('review')
  expect(execution.candidateSnapshotId).not.toBe(firstCandidate)
  expect(execution.interruptReason).toBeUndefined()
  expect(execution.pendingReply).toBeUndefined()
  expect(execution.checkpointId).toBe(
    piReviewCheckpointId(execution.operationId, execution.candidateSnapshotId)
  )
  expect(execution.artifactValidation?.issues).toEqual([])
  const effects = await effectRecords(snapshotRoot, scopeOf(execution))
  expect(effects).toContainEqual(
    expect.objectContaining({
      stepId: reviseStep,
      status: 'completed',
      candidateRevision: execution.candidateSnapshotId
    })
  )
  expect(faults.completedWrites.filter((item) => item.stepId === reviseStep)).toHaveLength(1)
  expect(recoveryCalls.count).toBe(0)
  expect(await readFile(workspaceEntry(snapshotRoot, scopeOf(execution)), 'utf8')).toBe(validScript)
  expect(await officialFacts(base)).toEqual(official)
  const status = await reopened.app.status.getSceneGenerationStatus(request)
  expect(status.state).toBe('waiting')
  expect(status.interaction?.kind).toBe('review')
  expect(status.interaction?.allowedReplies).toEqual(['accept', 'revise', 'discard'])
  const checkpoint = await reopened.app.ports.history.readCheckpoint({
    projectId: execution.projectId,
    sceneId: execution.sceneId,
    threadId: execution.threadId,
    branchId: execution.branchId,
    checkpointId: execution.checkpointId!
  })
  expect(checkpoint.view.summary).toBe('候选已发布，等待审阅')
  expect(checkpoint.view.canContinue).toBe(false)
}, 30000)

it('[C-4] 暂停继续首次写入已保存、候选未记录：重开后证明并进入审阅', async () => {
  const base = await generationFixture()
  const official = await officialFacts(base)
  const calls = { count: 0 }
  const app = await appWithModel(base, writeThenStopModel(calls))
  const operation = await app.generation.generateScene(request)
  await app.control.pauseSceneGeneration(request)
  await runQueued(base)
  const paused = (await app.ports.executions.readExecution(request))!
  expect(paused.state).toBe('interrupted')
  expect(paused.interruptReason).toBe('paused')
  expect(paused.candidateSnapshotId).toBeUndefined()
  expect(paused.checkpointId).toBeDefined()
  const scope = scopeOf(operation)
  const snapshotRoot = await newSnapshotRoot('write-recovery-pause-after-')
  installSaveFence({
    app,
    base,
    scope,
    snapshotRoot,
    saveNumber: 1,
    when: 'after',
    expectedStepId: 'generate-0'
  })
  await app.control.resumeSceneGeneration({
    projectId: paused.projectId,
    sceneId: paused.sceneId,
    operationId: paused.operationId,
    threadId: paused.threadId,
    branchId: paused.branchId,
    checkpointId: paused.checkpointId!,
    candidateSnapshotId: paused.candidateSnapshotId
  })
  await runQueuedIgnoringFailure(base)

  const recoveryCalls = { count: 0 }
  const reopened = await reopen(base, snapshotRoot, failModel(recoveryCalls))
  const stored = (await reopened.app.ports.executions.readExecution(request))!
  expect(stored.state).toBe('running')
  expect(stored.candidateSnapshotId).toBeUndefined()
  expect(stored.checkpointId).toBe(paused.checkpointId)
  faults.completedWrites = []

  await reopened.app.generation.resumeSceneGeneration(request)
  await reopened.run()

  const execution = (await reopened.app.ports.executions.readExecution(request))!
  expect(execution.state).toBe('waiting')
  expect(execution.interaction?.kind).toBe('review')
  expect(execution.candidateSnapshotId).toMatch(/^[0-9a-f]{40}$/u)
  expect(execution.checkpointId).toBe(
    piReviewCheckpointId(execution.operationId, execution.candidateSnapshotId)
  )
  expect(execution.interruptReason).toBeUndefined()
  const effects = await effectRecords(snapshotRoot, scope)
  expect(effects).toContainEqual(
    expect.objectContaining({
      stepId: 'generate-0',
      status: 'completed',
      candidateRevision: execution.candidateSnapshotId
    })
  )
  expect(faults.completedWrites.filter((item) => item.stepId === 'generate-0')).toHaveLength(1)
  expect(recoveryCalls.count).toBe(0)
  expect(await readFile(workspaceEntry(snapshotRoot, scope), 'utf8')).toBe(validScript)
  expect(await officialFacts(base)).toEqual(official)
  const status = await reopened.app.status.getSceneGenerationStatus(request)
  expect(status.state).toBe('waiting')
  expect(status.interaction?.kind).toBe('review')
}, 30000)

it('[C-4] 暂停继续写入前终止：保留现场并待核对，不重建工作区', async () => {
  const base = await generationFixture()
  const official = await officialFacts(base)
  const calls = { count: 0 }
  const app = await appWithModel(base, writeThenStopModel(calls))
  const operation = await app.generation.generateScene(request)
  await app.control.pauseSceneGeneration(request)
  await runQueued(base)
  const paused = (await app.ports.executions.readExecution(request))!
  const scope = scopeOf(operation)
  const snapshotRoot = await newSnapshotRoot('write-recovery-pause-before-')
  installSaveFence({
    app,
    base,
    scope,
    snapshotRoot,
    saveNumber: 1,
    when: 'before',
    expectedStepId: 'generate-0'
  })
  await app.control.resumeSceneGeneration({
    projectId: paused.projectId,
    sceneId: paused.sceneId,
    operationId: paused.operationId,
    threadId: paused.threadId,
    branchId: paused.branchId,
    checkpointId: paused.checkpointId!,
    candidateSnapshotId: paused.candidateSnapshotId
  })
  await runQueuedIgnoringFailure(base)

  const recoveryCalls = { count: 0 }
  const reopened = await reopen(base, snapshotRoot, failModel(recoveryCalls))
  const stored = (await reopened.app.ports.executions.readExecution(request))!
  expect(stored.state).toBe('running')
  expect(stored.candidateSnapshotId).toBeUndefined()
  const atCrash = await effectRecords(snapshotRoot, scope)
  expect(atCrash).toContainEqual(expect.objectContaining({ stepId: 'generate-0', status: 'started' }))
  expect(atCrash[0]).not.toHaveProperty('candidateRevision')

  await reopened.app.generation.resumeSceneGeneration(request)
  await reopened.run()

  const after = (await reopened.app.ports.executions.readExecution(request))!
  expect(after.state).toBe('interrupted')
  expect(after.interruptReason).toBe('writeUnknown')
  expect(after.candidateSnapshotId).toBeUndefined()
  expect(after.interaction).toBeUndefined()
  expect(after.failure?.message).toContain('待核对')
  expect(await effectRecords(snapshotRoot, scope)).toEqual(atCrash)
  expect(faults.completedWrites).toHaveLength(0)
  expect(recoveryCalls.count).toBe(0)
  expect(await readFile(workspaceEntry(snapshotRoot, scope), 'utf8')).toBe(validScript)
  expect(await officialFacts(base)).toEqual(official)
  const status = await reopened.app.status.getSceneGenerationStatus(request)
  expect(status.state).toBe('interrupted')
  expect(status.interaction).toBeUndefined()
  await expect(reopened.app.generation.resumeSceneGeneration(request)).rejects.toMatchObject({
    code: 4103
  })
}, 30000)

it('[B-1] 可审阅候选上的修改模型失败：明确本轮修改未执行，不冒充新审阅', async () => {
  const base = await generationFixture()
  const official = await officialFacts(base)
  const calls = { count: 0 }
  const fetcher = streamingFetch(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: ModelMessage[] }
    const last = body.messages.at(-1)
    calls.count += 1
    if (last?.role === 'tool') return stopResponse()
    if (last?.role === 'user' && calls.count === 1)
      return toolCallResponse(body.messages, validScript, 'w-1')
    return modelErrorResponse('revise model failed before writing')
  })
  const app = await appWithModel(base, fetcher)
  await app.generation.generateScene(request)
  await runQueued(base)
  const reviewed = (await app.ports.executions.readExecution(request))!
  expect(reviewed.state).toBe('waiting')
  expect(reviewed.interaction?.kind).toBe('review')
  const firstCandidate = reviewed.candidateSnapshotId!
  const effectsBefore = await effectRecords(base.config.userStateRoot, scopeOf(reviewed))

  await replyRevise(app, reviewed, 'revise-no-write', '把结尾改得更克制')
  await runQueued(base)

  const execution = (await app.ports.executions.readExecution(request))!
  expect(execution.state).toBe('waiting')
  expect(execution.interaction?.kind).toBe('correction')
  expect(execution.interaction?.message).toContain('本轮修改没有执行')
  expect(execution.interaction?.message).toContain('仍显示上一版候选')
  expect(execution.interaction?.message).not.toContain('候选还不能进入预览')
  expect(execution.interaction?.allowedReplies).toEqual(['revise', 'discard'])
  expect(execution.candidateSnapshotId).toBe(firstCandidate)
  expect(execution.artifactValidation?.issues).toEqual([])
  expect(await effectRecords(base.config.userStateRoot, scopeOf(execution))).toEqual(effectsBefore)
  expect(await readFile(workspaceEntry(base.config.userStateRoot, scopeOf(execution)), 'utf8')).toBe(
    validScript
  )
  expect(await officialFacts(base)).toEqual(official)
  expect(calls.count).toBe(2)
  const status = await app.status.getSceneGenerationStatus(request)
  expect(status.state).toBe('waiting')
  expect(status.interaction?.kind).toBe('correction')
  expect(status.interaction?.message).toContain('本轮修改没有执行')
  expect(status.interaction?.allowedReplies).toEqual(['revise', 'discard'])
  const checkpoint = await app.ports.history.readCheckpoint({
    projectId: execution.projectId,
    sceneId: execution.sceneId,
    threadId: execution.threadId,
    branchId: execution.branchId,
    checkpointId: execution.checkpointId!
  })
  expect(checkpoint.view.summary).toBe('候选需要修正，等待作者说明')
  expect(checkpoint.view.canContinue).toBe(false)
  expect(checkpoint.view.canReply).toBe(true)
}, 30000)

it('[B-1] 作者取消优先于修改未执行提示：保持 cancelled，不合成修正等待', async () => {
  const base = await generationFixture()
  const started = Promise.withResolvers<void>()
  const calls = { count: 0 }
  const fetcher = streamingFetch(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: ModelMessage[] }
    const last = body.messages.at(-1)
    calls.count += 1
    if (last?.role === 'tool') return stopResponse()
    if (last?.role === 'user' && calls.count === 1)
      return toolCallResponse(body.messages, validScript, 'w-1')
    started.resolve()
    const signal = init?.signal
    if (!signal) throw new Error('missing abort signal')
    const wait = Promise.withResolvers<Response>()
    if (signal.aborted) wait.reject(signal.reason)
    else signal.addEventListener('abort', () => wait.reject(signal.reason), { once: true })
    return wait.promise
  })
  const app = await appWithModel(base, fetcher)
  await app.generation.generateScene(request)
  await runQueued(base)
  const reviewed = (await app.ports.executions.readExecution(request))!
  expect(reviewed.state).toBe('waiting')
  await replyRevise(app, reviewed, 'revise-cancel', '把结尾改得更克制')
  const running = (async () => {
    const job = base.jobs.shift()
    if (!job) throw new Error('缺少任务')
    await job()
  })()
  await started.promise
  await app.control.cancelSceneGeneration(request)
  await running

  const execution = (await app.ports.executions.readExecution(request))!
  expect(execution.state).toBe('cancelled')
  expect(execution.interaction).toBeUndefined()
  expect(execution.failure).toBeUndefined()
  expect(execution.candidateSnapshotId).toBe(reviewed.candidateSnapshotId)
  expect(await effectRecords(base.config.userStateRoot, scopeOf(execution))).toContainEqual(
    expect.objectContaining({ stepId: 'generate-0', status: 'completed' })
  )
  const status = await app.status.getSceneGenerationStatus(request)
  expect(status.state).toBe('cancelled')
  expect(status.interaction).toBeUndefined()
}, 30000)

it('[P1] 副作用账本损坏不当作无需恢复：保留工作区与账本，不补结算也不调用模型', async () => {
  const base = await generationFixture()
  const official = await officialFacts(base)
  const calls = { count: 0 }
  const app = await appWithModel(base, writeTwiceThenStopModel(calls))
  const operation = await app.generation.generateScene(request)
  const scope = scopeOf(operation)
  const snapshotRoot = await newSnapshotRoot('write-recovery-corrupt-effect-')
  installSaveFence({
    app,
    base,
    scope,
    snapshotRoot,
    saveNumber: 2,
    when: 'after',
    expectedStepId: 'repair-1'
  })
  await runQueuedIgnoringFailure(base)

  const effectPath = await effectFile(snapshotRoot, scope, 'repair-1')
  const corrupted = '{"operationId":"broken"'
  await writeFile(effectPath, corrupted)
  const draftBefore = await readFile(workspaceEntry(snapshotRoot, scope))
  faults.completedWrites = []
  const recoveryCalls = { count: 0 }
  const reopened = await reopen(base, snapshotRoot, failModel(recoveryCalls))
  const stored = (await reopened.app.ports.executions.readExecution(request))!
  expect(stored.state).toBe('running')
  expect(stored.candidateSnapshotId).toMatch(/^[0-9a-f]{40}$/u)

  await reopened.app.generation.resumeSceneGeneration(request)
  await reopened.run()

  const execution = (await reopened.app.ports.executions.readExecution(request))!
  expect(execution.state).toBe('interrupted')
  expect(execution.interruptReason).toBe('writeUnknown')
  expect(execution.candidateSnapshotId).toBe(stored.candidateSnapshotId)
  expect(await readFile(effectPath, 'utf8')).toBe(corrupted)
  expect(await readFile(workspaceEntry(snapshotRoot, scope))).toEqual(draftBefore)
  expect(faults.completedWrites).toEqual([])
  expect(recoveryCalls.count).toBe(0)
  expect(await officialFacts(base)).toEqual(official)
  await expect(reopened.app.generation.resumeSceneGeneration(request)).rejects.toMatchObject({
    code: 4103
  })
}, 30000)

it('[P2] 完成回执已写、候选未绑定后重开：凭完成记录重建同一候选，不重复结算', async () => {
  const base = await generationFixture()
  const official = await officialFacts(base)
  const calls = { count: 0 }
  const app = await appWithModel(base, writeThenStopModel(calls))
  const operation = await app.generation.generateScene(request)
  const scope = scopeOf(operation)
  const snapshotRoot = await newSnapshotRoot('write-recovery-settled-unbound-')
  installSaveFence({
    app,
    base,
    scope,
    snapshotRoot,
    saveNumber: 1,
    when: 'after',
    expectedStepId: 'generate-0'
  })
  await runQueuedIgnoringFailure(base)
  faults.completedWrites = []

  const recoveryCalls = { count: 0 }
  const reopened = await reopen(base, snapshotRoot, failModel(recoveryCalls))
  const stored = (await reopened.app.ports.executions.readExecution(request))!
  expect(stored.candidateSnapshotId).toBeUndefined()
  const settled = await reopened.app.ports.writeRecovery.recoverCandidateWrite(
    stored,
    async () => {}
  )
  if (settled.outcome !== 'proven') throw new Error(`回执结算未证明：${settled.outcome}`)
  expect(settled.settled).toBe(true)
  expect(settled.candidateSnapshotId).toMatch(/^[0-9a-f]{40}$/u)
  // 模拟旧顺序的残留：完成回执已写，执行记录仍未绑定候选。
  expect((await reopened.app.ports.executions.readExecution(request))!.candidateSnapshotId).toBe(
    undefined
  )
  expect(faults.completedWrites.filter((item) => item.stepId === 'generate-0')).toHaveLength(1)

  await reopened.app.generation.resumeSceneGeneration(request)
  await reopened.run()

  const execution = (await reopened.app.ports.executions.readExecution(request))!
  expect(execution.state).toBe('waiting')
  expect(execution.interaction?.kind).toBe('review')
  expect(execution.candidateSnapshotId).toBe(settled.candidateSnapshotId)
  expect(execution.checkpointId).toBe(
    piReviewCheckpointId(execution.operationId, execution.candidateSnapshotId!)
  )
  expect(faults.completedWrites.filter((item) => item.stepId === 'generate-0')).toHaveLength(1)
  expect(recoveryCalls.count).toBe(0)
  expect(await readFile(workspaceEntry(snapshotRoot, scope), 'utf8')).toBe(validScript)
  expect(await officialFacts(base)).toEqual(official)
}, 30000)

it('[P2] 候选已绑定、完成回执未写后中断：下一次只补一次回执并进入审阅', async () => {
  const base = await generationFixture()
  const official = await officialFacts(base)
  const calls = { count: 0 }
  const app = await appWithModel(base, writeThenStopModel(calls))
  const operation = await app.generation.generateScene(request)
  const scope = scopeOf(operation)
  const snapshotRoot = await newSnapshotRoot('write-recovery-bound-unsettled-')
  installSaveFence({
    app,
    base,
    scope,
    snapshotRoot,
    saveNumber: 1,
    when: 'after',
    expectedStepId: 'generate-0'
  })
  await runQueuedIgnoringFailure(base)
  faults.completedWrites = []

  const recoveryCalls = { count: 0 }
  const reopened = await reopen(base, snapshotRoot, failModel(recoveryCalls))
  const stored = (await reopened.app.ports.executions.readExecution(request))!
  let bound: string | undefined
  const interrupted = await reopened.app.ports.writeRecovery.recoverCandidateWrite(
    stored,
    async (candidateSnapshotId) => {
      bound = candidateSnapshotId
      const current = (await reopened.app.ports.executions.readExecution(request))!
      await reopened.app.ports.executions.writeExecution({
        ...current,
        candidateSnapshotId,
        sequence: current.sequence + 1
      })
      throw new Error('fault fence: process terminated after candidate binding')
    }
  )
  expect(interrupted.outcome).toBe('unprovable')
  expect(bound).toMatch(/^[0-9a-f]{40}$/u)
  expect((await reopened.app.ports.executions.readExecution(request))!.candidateSnapshotId).toBe(
    bound
  )
  expect(
    (await effectRecords(snapshotRoot, scope)).find((effect) => effect.stepId === 'generate-0')?.status
  ).toBe('started')
  expect(faults.completedWrites).toEqual([])

  await reopened.app.generation.resumeSceneGeneration(request)
  await reopened.run()

  const execution = (await reopened.app.ports.executions.readExecution(request))!
  expect(execution.state).toBe('waiting')
  expect(execution.interaction?.kind).toBe('review')
  expect(execution.candidateSnapshotId).toBe(bound)
  expect(faults.completedWrites.filter((item) => item.stepId === 'generate-0')).toHaveLength(1)
  expect(
    (await effectRecords(snapshotRoot, scope)).find((effect) => effect.stepId === 'generate-0')?.status
  ).toBe('completed')
  expect(recoveryCalls.count).toBe(0)
  expect(await readFile(workspaceEntry(snapshotRoot, scope), 'utf8')).toBe(validScript)
  expect(await officialFacts(base)).toEqual(official)
}, 30000)

it('[P2] 候选绑定保存失败：完成回执保持未写，保留已写工作区待核对', async () => {
  const base = await generationFixture()
  const official = await officialFacts(base)
  const calls = { count: 0 }
  const app = await appWithModel(base, writeThenStopModel(calls))
  const operation = await app.generation.generateScene(request)
  const scope = scopeOf(operation)
  const snapshotRoot = await newSnapshotRoot('write-recovery-bind-failed-')
  installSaveFence({
    app,
    base,
    scope,
    snapshotRoot,
    saveNumber: 1,
    when: 'after',
    expectedStepId: 'generate-0'
  })
  await runQueuedIgnoringFailure(base)
  faults.completedWrites = []

  const recoveryCalls = { count: 0 }
  const reopened = await reopen(base, snapshotRoot, failModel(recoveryCalls))
  const stored = (await reopened.app.ports.executions.readExecution(request))!
  expect(stored.candidateSnapshotId).toBeUndefined()
  const originalWrite = reopened.app.ports.executions.writeExecution.bind(
    reopened.app.ports.executions
  )
  let candidateToBind: string | undefined
  vi.spyOn(reopened.app.ports.executions, 'writeExecution').mockImplementation(async (execution) => {
    if (candidateToBind === undefined && execution.candidateSnapshotId !== undefined) {
      candidateToBind = execution.candidateSnapshotId
      throw new Error('disk unavailable while binding candidate')
    }
    return originalWrite(execution)
  })

  await reopened.app.generation.resumeSceneGeneration(request)
  await reopened.run()

  const execution = (await reopened.app.ports.executions.readExecution(request))!
  expect(execution.state).toBe('interrupted')
  expect(execution.interruptReason).toBe('writeUnknown')
  expect(execution.candidateSnapshotId).toBe(candidateToBind)
  expect(await readFile(workspaceEntry(snapshotRoot, scope), 'utf8')).toBe(validScript)
  expect(
    (await effectRecords(snapshotRoot, scope)).find((effect) => effect.stepId === 'generate-0')?.status
  ).toBe('started')
  expect(faults.completedWrites).toEqual([])
  expect(recoveryCalls.count).toBe(0)
  expect(await officialFacts(base)).toEqual(official)
}, 30000)

it('[P3] 等待发布后中断：状态、交互、检查点与候选同一条记录，重开可接受且不调模型', async () => {
  const base = await generationFixture()
  const operation = await base.app.generation.generateScene({
    ...request,
    reviewCandidate: true
  })
  const scope = scopeOf(operation)
  const snapshotRoot = await newSnapshotRoot('generation-waiting-review-')
  installWaitingPublishFence({
    app: base.app,
    base,
    scope,
    snapshotRoot,
    kind: 'review'
  })
  await runQueuedIgnoringFailure(base)

  const recoveryCalls = { count: 0 }
  const reopened = await reopen(base, snapshotRoot, failModel(recoveryCalls))
  const status = await reopened.app.status.getSceneGenerationStatus(request)
  expect(status.state).toBe('waiting')
  expect(status.interaction?.kind).toBe('review')
  expect(status.interaction?.allowedReplies).toEqual(['accept', 'revise', 'discard'])
  expect(status.candidateSnapshotId).toMatch(/^[0-9a-f]{40}$/u)
  expect(status.canResume).toBe(false)
  expect(recoveryCalls.count).toBe(0)

  const stored = (await reopened.app.ports.executions.readExecution(request))!
  expect(stored.interaction?.checkpointId).toBe(stored.checkpointId)
  expect(stored.interaction?.candidateSnapshotId).toBe(stored.candidateSnapshotId)
  await reopened.app.generation.replySceneGenerationInteraction({
    projectId: stored.projectId,
    sceneId: stored.sceneId,
    operationId: stored.operationId,
    threadId: stored.threadId,
    branchId: stored.branchId,
    interactionId: stored.interaction!.interactionId,
    checkpointId: stored.checkpointId!,
    candidateSnapshotId: stored.candidateSnapshotId!,
    replyId: 'accept-after-waiting-publish',
    reply: { kind: 'accept' }
  })
  await reopened.run()

  const finished = await reopened.app.status.getSceneGenerationStatus(request)
  expect(finished.state).toBe('succeeded')
  expect(finished.result?.commitId).toBeTruthy()
  expect(recoveryCalls.count).toBe(0)
  expect(await readFile(join(base.projectRoot, 'game/scene/start.txt'), 'utf8')).toBe(validScript)
  expect(await officialFacts(base)).toEqual({
    entry: validScript,
    head: finished.result!.commitId
  })
}, 30000)

it('[P3] 写前题组等待发布后中断：重开保留完整题组，回答后继续生成', async () => {
  const base = await clarificationAnswerFixture([
    {
      prompt: '告别后各自去哪里？',
      detail: '需要作者决定去向',
      options: [
        { label: '回家', description: '各自回家' },
        { label: '留下', description: '留在车站' },
        { label: '不详', description: '不写去向' }
      ]
    }
  ])
  const official = await officialFacts(base)
  const operation = await base.app.generation.generateScene({
    ...request,
    reviewCandidate: true
  })
  const scope = scopeOf(operation)
  const snapshotRoot = await newSnapshotRoot('generation-waiting-questions-')
  installWaitingPublishFence({
    app: base.app,
    base,
    scope,
    snapshotRoot,
    kind: 'decision'
  })
  await runQueuedIgnoringFailure(base)

  const afterAnswer = { count: 0 }
  const reopened = await reopen(base, snapshotRoot, writeThenStopModel(afterAnswer))
  const status = await reopened.app.status.getSceneGenerationStatus(request)
  expect(status.state).toBe('waiting')
  expect(status.interaction?.kind).toBe('decision')
  expect(status.interaction?.questions).toHaveLength(1)
  expect(status.interaction?.allowedReplies).toEqual(['answers', 'discard'])
  expect(status.candidateSnapshotId).toBeUndefined()
  expect(afterAnswer.count).toBe(0)

  const stored = (await reopened.app.ports.executions.readExecution(request))!
  const questions = stored.interaction!.questions!
  await reopened.app.generation.replySceneGenerationInteraction({
    projectId: stored.projectId,
    sceneId: stored.sceneId,
    operationId: stored.operationId,
    threadId: stored.threadId,
    branchId: stored.branchId,
    interactionId: stored.interaction!.interactionId,
    checkpointId: stored.interaction!.checkpointId,
    replyId: 'answers-after-waiting-publish',
    reply: {
      kind: 'answers',
      answers: questions.map((question, index) => ({
        questionId: question.questionId,
        optionId: question.options[index % question.options.length]!.id
      }))
    }
  })
  await reopened.run()

  const review = await reopened.app.status.getSceneGenerationStatus(request)
  expect(review.state).toBe('waiting')
  expect(review.interaction?.kind).toBe('review')
  expect(review.candidateSnapshotId).toMatch(/^[0-9a-f]{40}$/u)
  expect(afterAnswer.count).toBeGreaterThan(0)
  expect(await officialFacts(base)).toEqual(official)
}, 30000)

it('[P3] 题组等待发布保存失败：不伪造题组，不重新调用模型冒充成功', async () => {
  const base = await clarificationAnswerFixture([
    {
      prompt: '告别后各自去哪里？',
      detail: '需要作者决定去向',
      options: [
        { label: '回家', description: '各自回家' },
        { label: '留下', description: '留在车站' },
        { label: '不详', description: '不写去向' }
      ]
    }
  ])
  const official = await officialFacts(base)
  const originalWrite = base.app.ports.executions.writeExecution.bind(
    base.app.ports.executions
  )
  let failed = false
  vi.spyOn(base.app.ports.executions, 'writeExecution').mockImplementation(async (execution) => {
    if (!failed && execution.state === 'waiting' && execution.interaction?.kind === 'decision') {
      failed = true
      throw new Error('disk unavailable while publishing questions')
    }
    return originalWrite(execution)
  })

  await base.app.generation.generateScene(request)
  await runQueuedIgnoringFailure(base)

  const execution = (await base.app.ports.executions.readExecution(request))!
  expect(execution.state).toBe('failed')
  expect(execution.interaction).toBeUndefined()
  expect(execution.failure).toBeTruthy()
  const status = await base.app.status.getSceneGenerationStatus(request)
  expect(status.state).not.toBe('waiting')
  expect(status.interaction).toBeUndefined()
  expect(await officialFacts(base)).toEqual(official)

  const recoveryCalls = { count: 0 }
  const reopened = await reopen(base, base.config.userStateRoot, failModel(recoveryCalls))
  const reopenedStatus = await reopened.app.status.getSceneGenerationStatus(request)
  expect(reopenedStatus.state).toBe('failed')
  expect(reopenedStatus.interaction).toBeUndefined()
  await reopened.app.generation.resumeSceneGeneration(request)
  expect(recoveryCalls.count).toBe(0)
  expect(await officialFacts(base)).toEqual(official)
}, 30000)

it('[P3-C1] 取消受理后迟到的等待发布被拒绝：重开完成取消，不能恢复等待或改作品', async () => {
  const base = await generationFixture()
  const official = await officialFacts(base)
  const commitsBefore = Number(base.git('rev-list', '--count', 'HEAD'))
  const calls = { count: 0 }
  const app = await appWithModel(base, writeThenStopModel(calls))

  const inspecting = Promise.withResolvers<void>()
  const releaseInspection = Promise.withResolvers<void>()
  let blockedInspection = false
  const originalInspect = app.ports.versions.inspectBaseline.bind(app.ports.versions)
  vi.spyOn(app.ports.versions, 'inspectBaseline').mockImplementation(async (execution) => {
    const facts = await originalInspect(execution)
    if (!blockedInspection && execution.candidateSnapshotId !== undefined) {
      blockedInspection = true
      inspecting.resolve()
      await releaseInspection.promise
    }
    return facts
  })

  let cancelAccepted = false
  let lateWaitingWrites = 0
  const originalWrite = app.ports.executions.writeExecution.bind(app.ports.executions)
  vi.spyOn(app.ports.executions, 'writeExecution').mockImplementation(async (execution) => {
    if (cancelAccepted && execution.state === 'waiting') lateWaitingWrites += 1
    return originalWrite(execution)
  })

  const cleanupReached = Promise.withResolvers<void>()
  const releaseCleanup = Promise.withResolvers<void>()
  let blockedCleanup = false
  const originalDiscard = app.ports.workspace.discardWorkspace.bind(app.ports.workspace)
  vi.spyOn(app.ports.workspace, 'discardWorkspace').mockImplementation(async (execution) => {
    if (cancelAccepted && !blockedCleanup) {
      blockedCleanup = true
      cleanupReached.resolve()
      await releaseCleanup.promise
    }
    return originalDiscard(execution)
  })

  await app.generation.generateScene({ ...request, reviewCandidate: true })
  const running = runQueued(base)
  await inspecting.promise
  await expect(app.control.cancelSceneGeneration(request)).resolves.toMatchObject({
    state: 'cancelling'
  })
  cancelAccepted = true
  const cancelling = (await app.ports.executions.readExecution(request))!
  expect(cancelling.state).toBe('cancelling')
  expect(cancelling.cancellationRequested).toBe(true)
  expect(cancelling.interaction).toBeUndefined()

  // 放行迟到的等待进度；它只能被已受理取消拒绝，旧后台随后进入取消清理。
  releaseInspection.resolve()
  await cleanupReached.promise
  const snapshotRoot = await newSnapshotRoot('generation-cancel-late-wait-')
  const snapshot = await copyStableState(
    base.config.userStateRoot,
    snapshotRoot,
    scopeOf(cancelling)
  )
  expect(snapshot.state).toBe('cancelling')
  expect(snapshot.cancellationRequested).toBe(true)
  expect(snapshot.pendingReply).toBeUndefined()

  const recoveryCalls = { count: 0 }
  const reopened = await reopen(base, snapshotRoot, failModel(recoveryCalls))
  const beforeCleanup = (await reopened.app.ports.executions.readExecution(request))!
  expect(beforeCleanup.state).toBe('cancelling')
  expect(beforeCleanup.cancellationRequested).toBe(true)
  const repliesBefore = beforeCleanup.replies.length
  await expect(
    reopened.app.generation.replySceneGenerationInteraction({
      projectId: beforeCleanup.projectId,
      sceneId: beforeCleanup.sceneId,
      operationId: beforeCleanup.operationId,
      threadId: beforeCleanup.threadId,
      branchId: beforeCleanup.branchId,
      interactionId: 'late-waiting-interaction',
      checkpointId: beforeCleanup.checkpointId ?? 'late-waiting-checkpoint',
      replyId: 'late-accept',
      reply: { kind: 'accept' }
    })
  ).rejects.toMatchObject({ code: 4103 })
  expect((await reopened.app.ports.executions.readExecution(request))!.replies).toHaveLength(
    repliesBefore
  )

  await expect(reopened.app.generation.resumeSceneGeneration(request)).resolves.toMatchObject({
    state: 'cancelled'
  })
  const cancelled = (await reopened.app.ports.executions.readExecution(request))!
  expect(cancelled.state).toBe('cancelled')
  expect(cancelled.cancellationRequested).toBe(true)
  expect(cancelled.interaction).toBeUndefined()
  expect(cancelled.pendingReply).toBeUndefined()
  expect(cancelled.replies).toHaveLength(repliesBefore)
  await expect(
    reopened.app.generation.replySceneGenerationInteraction({
      projectId: cancelled.projectId,
      sceneId: cancelled.sceneId,
      operationId: cancelled.operationId,
      threadId: cancelled.threadId,
      branchId: cancelled.branchId,
      interactionId: 'cancelled-interaction',
      checkpointId: cancelled.checkpointId ?? 'cancelled-checkpoint',
      replyId: 'cancelled-accept',
      reply: { kind: 'accept' }
    })
  ).rejects.toMatchObject({ code: 4103 })
  expect(await officialFacts(base)).toEqual(official)
  expect(recoveryCalls.count).toBe(0)

  releaseCleanup.resolve()
  await running
  expect(lateWaitingWrites).toBe(0)
  const settled = (await app.ports.executions.readExecution(request))!
  expect(settled.state).toBe('cancelled')
  expect(settled.cancellationRequested).toBe(true)
  expect(Number(base.git('rev-list', '--count', 'HEAD'))).toBe(commitsBefore)
}, 30000)

it('[P3-C1] 先发布等待再取消：走既有取消语义，迟到收尾不改写取消事实', async () => {
  const base = await generationFixture()
  const official = await officialFacts(base)
  await base.app.generation.generateScene({ ...request, reviewCandidate: true })
  await base.run()
  const waiting = (await base.app.ports.executions.readExecution(request))!
  expect(waiting.state).toBe('waiting')
  expect(waiting.interaction?.kind).toBe('review')

  await expect(base.app.control.cancelSceneGeneration(request)).resolves.toMatchObject({
    state: 'cancelled'
  })
  const cancelled = (await base.app.ports.executions.readExecution(request))!
  expect(cancelled.state).toBe('cancelled')
  expect(cancelled.cancellationRequested).toBe(true)
  expect(cancelled.interaction).toBeUndefined()
  expect(cancelled.pendingReply).toBeUndefined()
  expect(cancelled.requiresCleanup).toBe(false)
  await expect(
    base.app.generation.replySceneGenerationInteraction({
      projectId: cancelled.projectId,
      sceneId: cancelled.sceneId,
      operationId: cancelled.operationId,
      threadId: cancelled.threadId,
      branchId: cancelled.branchId,
      interactionId: waiting.interaction!.interactionId,
      checkpointId: waiting.checkpointId!,
      candidateSnapshotId: waiting.candidateSnapshotId!,
      replyId: 'accept-after-cancel',
      reply: { kind: 'accept' }
    })
  ).rejects.toMatchObject({ code: 4103 })
  expect(await officialFacts(base)).toEqual(official)
}, 30000)

it('[P3-C1] 打开工程结算遗留取消：清理失败可重试、重复打开不重复清理，之后同场景可再生成', async () => {
  const base = await generationFixture()
  const official = await officialFacts(base)
  const modelCalls = { count: 0 }
  const app = await appWithModel(base, writeThenStopModel(modelCalls))

  const inspecting = Promise.withResolvers<void>()
  const releaseInspection = Promise.withResolvers<void>()
  let blockedInspection = false
  const originalInspect = app.ports.versions.inspectBaseline.bind(app.ports.versions)
  vi.spyOn(app.ports.versions, 'inspectBaseline').mockImplementation(async (execution) => {
    const facts = await originalInspect(execution)
    if (!blockedInspection && execution.candidateSnapshotId !== undefined) {
      blockedInspection = true
      inspecting.resolve()
      await releaseInspection.promise
    }
    return facts
  })

  const cleanupReached = Promise.withResolvers<void>()
  const releaseCleanup = Promise.withResolvers<void>()
  let blockedCleanup = false
  const originalDiscard = app.ports.workspace.discardWorkspace.bind(app.ports.workspace)
  vi.spyOn(app.ports.workspace, 'discardWorkspace').mockImplementation(async (execution) => {
    if (!blockedCleanup) {
      blockedCleanup = true
      cleanupReached.resolve()
      await releaseCleanup.promise
    }
    return originalDiscard(execution)
  })

  await app.generation.generateScene({ ...request, reviewCandidate: true })
  const running = runQueued(base)
  await inspecting.promise
  await expect(app.control.cancelSceneGeneration(request)).resolves.toMatchObject({
    state: 'cancelling'
  })
  const cancelling = (await app.ports.executions.readExecution(request))!
  expect(cancelling.state).toBe('cancelling')
  expect(cancelling.cancellationRequested).toBe(true)
  releaseInspection.resolve()
  await cleanupReached.promise

  const snapshotRoot = await newSnapshotRoot('generation-cancel-cleanup-')
  const snapshot = await copyStableState(
    base.config.userStateRoot,
    snapshotRoot,
    scopeOf(cancelling)
  )
  expect(snapshot.state).toBe('cancelling')
  expect(snapshot.cancellationRequested).toBe(true)

  const recoveryCalls = { count: 0 }
  const reopened = await reopen(base, snapshotRoot, failModel(recoveryCalls))
  const stored = (await reopened.app.ports.executions.readExecution(request))!
  const originalFailure = safeFailureWithDiagnosticRef(
    new AppException({ code: ErrorCodes.internalError, msg: '提交失败' })
  )
  await reopened.app.ports.executions.writeExecution({
    ...stored,
    failure: originalFailure
  })

  const originalReopenedDiscard =
    reopened.app.ports.workspace.discardWorkspace.bind(reopened.app.ports.workspace)
  let discardAttempts = 0
  vi.spyOn(reopened.app.ports.workspace, 'discardWorkspace').mockImplementation(
    async (execution) => {
      discardAttempts += 1
      if (discardAttempts === 1) throw new Error('cleanup unavailable')
      return originalReopenedDiscard(execution)
    }
  )

  const recoveries: Array<{ attempted: number; failed: number }> = []
  const logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  }
  const controller = new ProjectController(
    {
      openProject: async (openRequest: { id: string }) => ({
        id: openRequest.id,
        name: '取消清理样本',
        synopsis: ''
      })
    } as unknown as ProjectApplicationService,
    new IpcExceptionHandler(logger, new IpcErrorMapper()),
    async (projectId) => {
      recoveries.push(await reopened.app.recovery.recoverCancelledProject(projectId))
    }
  )
  const open = (): ReturnType<ProjectController['openProject']> =>
    controller.openProject(
      { id: request.projectId },
      { trusted: true, requestId: 'project-open-cancel-cleanup' }
    )

  await expect(open()).resolves.toMatchObject({ code: ErrorCodes.success })
  expect(recoveries.at(-1)).toEqual({ attempted: 1, failed: 1 })
  const interrupted = (await reopened.app.ports.executions.readExecution(request))!
  expect(interrupted).toMatchObject({
    state: 'interrupted',
    requiresCleanup: true,
    cancellationRequested: true
  })
  expect(interrupted.failure).toEqual(originalFailure)
  const failureRender = toRenderStatusVO(interrupted, false, { resume: true, pause: true })
  expect(failureRender.canResume).toBe(false)
  expect(failureRender.canCancel).toBe(true)
  expect(failureRender.stageMessage).toBe('取消尚未完成清理，请重新结束本次生成')
  expect(failureRender.resumeReason).toContain('取消尚未完成清理')

  // 无法通过打开工程收尾时，真实取消控制入口仍可重试同一份取消清理。
  const cancelController = new SceneGenerationController(
    {
      launch: reopened.app.launch,
      renderQuery: reopened.app.renderQuery,
      control: reopened.app.control,
      history: reopened.app.history,
      preview: reopened.app.candidatePreview,
      generation: reopened.app.generation
    } as unknown as SceneGenerationApplicationGateway,
    new IpcExceptionHandler(logger, new IpcErrorMapper())
  )
  const cancelClient = new SceneGenerationClientImpl({
    cancelSceneGeneration: (input: unknown) =>
      cancelController.cancel(input, {
        trusted: true,
        requestId: 'cancel-cleanup-retry'
      })
  } as unknown as DesktopBridge)
  await expect(
    cancelClient.cancel({
      projectId: stored.projectId,
      sceneId: stored.sceneId,
      operationId: stored.operationId
    })
  ).resolves.toMatchObject({
    code: ErrorCodes.success,
    msg: '场景生成已取消',
    data: { state: 'cancelled', canCancel: false }
  })
  const settled = (await reopened.app.ports.executions.readExecution(request))!
  expect(settled.state).toBe('cancelled')
  expect(settled.cancellationRequested).toBe(true)
  expect(settled.requiresCleanup).toBe(false)
  const settledSequence = settled.sequence
  const settledDiscards = discardAttempts

  // 再次打开工程只读已结算记录，不重复清理、不推进序号。
  await expect(open()).resolves.toMatchObject({ code: ErrorCodes.success })
  expect(recoveries.at(-1)).toEqual({ attempted: 0, failed: 0 })
  const afterThirdOpen = (await reopened.app.ports.executions.readExecution(request))!
  expect(afterThirdOpen.sequence).toBe(settledSequence)
  expect(discardAttempts).toBe(settledDiscards)
  expect(recoveryCalls.count).toBe(0)
  expect(await officialFacts(base)).toEqual(official)

  const next = await reopened.app.generation.generateScene({
    ...request,
    operationId: 'operation-after-cancel'
  })
  expect(next.operationId).toBe('operation-after-cancel')
  const nextExecution = await reopened.app.ports.executions.readExecution(next)
  expect(nextExecution?.state).toBe('pending')

  releaseCleanup.resolve()
  await running
}, 30000)

it('[P3-C2] 修改被消费后新审阅等待在最终更新前中断：重开保留新交互，不重放旧修改', async () => {
  const revised =
    'changeBg:station.svg;\n林:末班车快到了，这次真的该走了。;\nsay:车站的灯亮了。 -clear;\nend;'
  const base = await generationFixture({
    scriptForWrite: (writes) => (writes === 1 ? validScript : revised)
  })
  const official = await officialFacts(base)
  const commitsBefore = Number(base.git('rev-list', '--count', 'HEAD'))
  await base.app.generation.generateScene({ ...request, reviewCandidate: true })
  await base.run()
  const first = (await base.app.ports.executions.readExecution(request))!
  expect(first.state).toBe('waiting')
  expect(first.interaction?.kind).toBe('review')
  await base.app.generation.replySceneGenerationInteraction({
    projectId: first.projectId,
    sceneId: first.sceneId,
    operationId: first.operationId,
    threadId: first.threadId,
    branchId: first.branchId,
    interactionId: first.interaction!.interactionId,
    checkpointId: first.checkpointId!,
    candidateSnapshotId: first.candidateSnapshotId!,
    replyId: 'revise-before-new-wait',
    reply: { kind: 'revise', body: '把结尾改得更克制' }
  })

  const snapshotRoot = await newSnapshotRoot('generation-waiting-after-revise-')
  installWaitingPublishFence({
    app: base.app,
    base,
    scope: scopeOf(first),
    snapshotRoot,
    kind: 'review'
  })
  await runQueuedIgnoringFailure(base)

  const recoveryCalls = { count: 0 }
  const reopened = await reopen(base, snapshotRoot, failModel(recoveryCalls))
  const stored = (await reopened.app.ports.executions.readExecution(request))!
  expect(stored.state).toBe('waiting')
  expect(stored.interaction?.kind).toBe('review')
  expect(stored.interaction?.interactionId).not.toBe(first.interaction!.interactionId)
  expect(stored.candidateSnapshotId).not.toBe(first.candidateSnapshotId)
  expect(stored.checkpointId).toBe(stored.interaction?.checkpointId)
  expect(stored.pendingReply).toBeUndefined()
  expect(
    stored.replies.filter((reply) => reply.replyId === 'revise-before-new-wait')
  ).toHaveLength(1)
  expect(await officialFacts(base)).toEqual(official)

  await reopened.app.generation.replySceneGenerationInteraction({
    projectId: stored.projectId,
    sceneId: stored.sceneId,
    operationId: stored.operationId,
    threadId: stored.threadId,
    branchId: stored.branchId,
    interactionId: stored.interaction!.interactionId,
    checkpointId: stored.checkpointId!,
    candidateSnapshotId: stored.candidateSnapshotId!,
    replyId: 'accept-after-new-wait',
    reply: { kind: 'accept' }
  })
  await reopened.run()
  const finished = await reopened.app.status.getSceneGenerationStatus(request)
  expect(finished.state).toBe('succeeded')
  expect(recoveryCalls.count).toBe(0)
  expect(
    (await reopened.app.ports.executions.readExecution(request))!.replies.map(
      (reply) => reply.replyId
    )
  ).toEqual(['revise-before-new-wait', 'accept-after-new-wait'])
  expect(await readFile(join(base.projectRoot, 'game/scene/start.txt'), 'utf8')).toBe(revised)
  expect((await officialFacts(base)).head).toBe(finished.result!.commitId)
  expect(Number(base.git('rev-list', '--count', 'HEAD'))).toBe(commitsBefore + 1)
}, 30000)

it('[P3-C2] 整组回答被消费后新审阅等待在最终更新前中断：重开不重放旧回答', async () => {
  const base = await clarificationAnswerFixture([
    {
      prompt: '告别后各自去哪里？',
      detail: '需要作者决定去向',
      options: [
        { label: '回家', description: '各自回家' },
        { label: '留下', description: '留在车站' },
        { label: '不详', description: '不写去向' }
      ]
    }
  ])
  const official = await officialFacts(base)
  const commitsBefore = Number(base.git('rev-list', '--count', 'HEAD'))
  await base.app.generation.generateScene({ ...request, reviewCandidate: true })
  await base.run()
  const waiting = (await base.app.ports.executions.readExecution(request))!
  expect(waiting.state).toBe('waiting')
  expect(waiting.interaction?.kind).toBe('decision')
  const question = waiting.interaction!.questions![0]!
  await base.app.generation.replySceneGenerationInteraction({
    projectId: waiting.projectId,
    sceneId: waiting.sceneId,
    operationId: waiting.operationId,
    threadId: waiting.threadId,
    branchId: waiting.branchId,
    interactionId: waiting.interaction!.interactionId,
    checkpointId: waiting.checkpointId!,
    replyId: 'answers-before-new-wait',
    reply: {
      kind: 'answers',
      answers: [{ questionId: question.questionId, optionId: question.options[0]!.id }]
    }
  })

  const snapshotRoot = await newSnapshotRoot('generation-waiting-after-answers-')
  installWaitingPublishFence({
    app: base.app,
    base,
    scope: scopeOf(waiting),
    snapshotRoot,
    kind: 'review'
  })
  await runQueuedIgnoringFailure(base)

  const recoveryCalls = { count: 0 }
  const reopened = await reopen(base, snapshotRoot, failModel(recoveryCalls))
  const stored = (await reopened.app.ports.executions.readExecution(request))!
  expect(stored.state).toBe('waiting')
  expect(stored.interaction?.kind).toBe('review')
  expect(stored.candidateSnapshotId).toMatch(/^[0-9a-f]{40}$/u)
  expect(stored.pendingReply).toBeUndefined()
  expect(
    stored.replies.filter((reply) => reply.replyId === 'answers-before-new-wait')
  ).toHaveLength(1)
  expect(await officialFacts(base)).toEqual(official)

  await reopened.app.generation.replySceneGenerationInteraction({
    projectId: stored.projectId,
    sceneId: stored.sceneId,
    operationId: stored.operationId,
    threadId: stored.threadId,
    branchId: stored.branchId,
    interactionId: stored.interaction!.interactionId,
    checkpointId: stored.checkpointId!,
    candidateSnapshotId: stored.candidateSnapshotId!,
    replyId: 'accept-after-answers-wait',
    reply: { kind: 'accept' }
  })
  await reopened.run()
  const finished = await reopened.app.status.getSceneGenerationStatus(request)
  expect(finished.state).toBe('succeeded')
  expect(recoveryCalls.count).toBe(0)
  expect(
    (await reopened.app.ports.executions.readExecution(request))!.replies.map(
      (reply) => reply.replyId
    )
  ).toEqual(['answers-before-new-wait', 'accept-after-answers-wait'])
  expect(await officialFacts(base)).toEqual({
    entry: validScript,
    head: finished.result!.commitId
  })
  expect(Number(base.git('rev-list', '--count', 'HEAD'))).toBe(commitsBefore + 1)
}, 30000)

it('[P3-C2][测试边界] 旧 accept 指针遗留在新等待：重开只消费旧接受，不重放、不丢工作区', async () => {
  // 真实装配无法在审阅接受后自然产生新候选（可审阅即直接进入提交），
  // 因而用真实执行记录端口写入旧代码可能留下的现场；重开、回复与提交仍走公开入口。
  const base = await generationFixture()
  const official = await officialFacts(base)
  const commitsBefore = Number(base.git('rev-list', '--count', 'HEAD'))
  await base.app.generation.generateScene({ ...request, reviewCandidate: true })
  await base.run()
  const waiting = (await base.app.ports.executions.readExecution(request))!
  expect(waiting.state).toBe('waiting')
  const acceptedReply = {
    projectId: waiting.projectId,
    sceneId: waiting.sceneId,
    operationId: waiting.operationId,
    threadId: waiting.threadId,
    branchId: waiting.branchId,
    interactionId: waiting.interaction!.interactionId,
    checkpointId: waiting.checkpointId!,
    candidateSnapshotId: waiting.candidateSnapshotId!,
    replyId: 'accept-before-new-wait',
    reply: { kind: 'accept' as const }
  }
  const nextInteraction = {
    ...waiting.interaction!,
    interactionId: 'review-after-old-accept'
  }
  await base.app.ports.executions.writeExecution({
    ...waiting,
    interaction: nextInteraction,
    pendingReply: acceptedReply,
    replies: [...waiting.replies, acceptedReply],
    sequence: waiting.sequence + 1
  })

  const recoveryCalls = { count: 0 }
  const reopened = await reopen(base, base.config.userStateRoot, failModel(recoveryCalls))
  await expect(reopened.app.generation.resumeSceneGeneration(request)).resolves.toMatchObject({
    state: 'waiting'
  })
  const resumed = (await reopened.app.ports.executions.readExecution(request))!
  expect(resumed.state).toBe('waiting')
  expect(resumed.interaction?.interactionId).toBe('review-after-old-accept')
  expect(resumed.pendingReply).toBeUndefined()
  expect(resumed.replies.map((reply) => reply.replyId)).toEqual(['accept-before-new-wait'])
  // 旧接受没有被重放去删工作区或失败清理。
  expect(await readFile(workspaceEntry(base.config.userStateRoot, scopeOf(resumed)), 'utf8')).toBe(
    validScript
  )
  expect(await officialFacts(base)).toEqual(official)

  await reopened.app.generation.replySceneGenerationInteraction({
    projectId: resumed.projectId,
    sceneId: resumed.sceneId,
    operationId: resumed.operationId,
    threadId: resumed.threadId,
    branchId: resumed.branchId,
    interactionId: resumed.interaction!.interactionId,
    checkpointId: resumed.checkpointId!,
    candidateSnapshotId: resumed.candidateSnapshotId!,
    replyId: 'accept-after-old-accept',
    reply: { kind: 'accept' }
  })
  await reopened.run()
  const finished = await reopened.app.status.getSceneGenerationStatus(request)
  expect(finished.state).toBe('succeeded')
  expect(recoveryCalls.count).toBe(0)
  expect(
    (await reopened.app.ports.executions.readExecution(request))!.replies.map(
      (reply) => reply.replyId
    )
  ).toEqual(['accept-before-new-wait', 'accept-after-old-accept'])
  expect((await officialFacts(base)).head).toBe(finished.result!.commitId)
  expect(Number(base.git('rev-list', '--count', 'HEAD'))).toBe(commitsBefore + 1)
}, 30000)

it('[P4/P6] 带决定变更的分叉第二次写入后中断：按恢复后的候选续作并保留来源关系', async () => {
  const sourceScript = validScript
  const forkInvalid = validScript.replace('station.svg', 'missing.svg')
  const forkFinal = 'changeBg:station.svg;\n林:分叉后的台词 -clear;\nend;'
  const base = await generationFixture({
    scriptForWrite: (writes) =>
      writes === 1 ? sourceScript : writes === 2 ? forkInvalid : forkFinal
  })
  const official = await officialFacts(base)
  await base.app.generation.generateScene({
    ...request,
    reviewCandidate: true
  })
  await base.run()
  const source = (await base.app.ports.executions.readExecution(request))!
  const sourceDraft = await readFile(
    workspaceEntry(base.config.userStateRoot, scopeOf(source)),
    'utf8'
  )
  await base.app.generation.forkSceneGeneration({
    projectId: request.projectId,
    sceneId: request.sceneId,
    threadId: source.threadId,
    branchId: source.branchId,
    checkpointId: source.checkpointId!,
    operationId: 'fork-crash',
    policy: request.policy,
    reviewCandidate: true,
    decisionChanges: [
      {
        interactionId: source.interaction!.interactionId,
        reply: { kind: 'revise', body: '改成各自回家' }
      }
    ]
  })
  const forkScope = {
    projectId: request.projectId,
    sceneId: request.sceneId,
    threadId: source.threadId,
    operationId: 'fork-crash'
  }
  const snapshotRoot = await newSnapshotRoot('generation-fork-second-write-')
  installSaveFence({
    app: base.app,
    base,
    scope: forkScope,
    snapshotRoot,
    saveNumber: 2,
    when: 'after',
    expectedStepId: 'repair-1'
  })
  await runQueuedIgnoringFailure(base)

  const recoveryCalls = { count: 0 }
  const reopened = await reopen(base, snapshotRoot, failModel(recoveryCalls))
  const stored = (await reopened.app.ports.executions.readExecution(forkScope))!
  expect(stored.state).toBe('running')
  expect(stored.candidateSnapshotId).toBeDefined()
  const forkAtCrash = stored.fork
  expect(forkAtCrash?.candidateSnapshotId).toBe(source.candidateSnapshotId)
  const atCrash = await effectRecords(snapshotRoot, forkScope)
  expect(atCrash).toContainEqual(
    expect.objectContaining({ stepId: 'repair-0', status: 'completed' })
  )
  expect(atCrash).toContainEqual(expect.objectContaining({ stepId: 'repair-1', status: 'started' }))
  faults.completedWrites = []

  await reopened.app.generation.resumeSceneGeneration({
    ...forkScope,
    branchId: stored.branchId
  })
  await reopened.run()

  const execution = (await reopened.app.ports.executions.readExecution(forkScope))!
  expect(execution.state).toBe('waiting')
  expect(execution.interaction?.kind).toBe('review')
  expect(execution.candidateSnapshotId).toBeDefined()
  expect(execution.candidateSnapshotId).not.toBe(stored.candidateSnapshotId)
  expect(execution.fork).toEqual(forkAtCrash)
  expect(execution.forkRequest).toBeUndefined()
  expect(execution.checkpointId).toBe(
    piReviewCheckpointId(execution.operationId, execution.candidateSnapshotId!)
  )
  expect(
    await readFile(workspaceEntry(snapshotRoot, forkScope), 'utf8')
  ).toBe(forkFinal)
  expect(
    await readFile(workspaceEntry(base.config.userStateRoot, scopeOf(source)), 'utf8')
  ).toBe(sourceDraft)
  expect(await base.app.ports.executions.readExecution(request)).toEqual(source)
  expect(await officialFacts(base)).toEqual(official)
  expect(recoveryCalls.count).toBe(0)
  expect(faults.completedWrites.filter((item) => item.stepId === 'repair-1')).toHaveLength(1)

  await reopened.app.generation.replySceneGenerationInteraction({
    projectId: execution.projectId,
    sceneId: execution.sceneId,
    operationId: execution.operationId,
    threadId: execution.threadId,
    branchId: execution.branchId,
    interactionId: execution.interaction!.interactionId,
    checkpointId: execution.checkpointId!,
    candidateSnapshotId: execution.candidateSnapshotId!,
    replyId: 'accept-after-fork-recovery',
    reply: { kind: 'accept' }
  })
  await reopened.run()

  const finished = await reopened.app.status.getSceneGenerationStatus(forkScope)
  expect(finished.state).toBe('succeeded')
  expect(await readFile(join(base.projectRoot, 'game/scene/start.txt'), 'utf8')).toBe(forkFinal)
  expect(recoveryCalls.count).toBe(0)
}, 30000)

it('[P4] 分叉首次写入已结算后中断：从已证候选续作，不因已有写入必然拒绝', async () => {
  const forkInvalid = validScript.replace('station.svg', 'missing.svg')
  const base = await generationFixture({
    scriptForWrite: (writes) => (writes === 1 ? validScript : forkInvalid)
  })
  const official = await officialFacts(base)
  await base.app.generation.generateScene({
    ...request,
    reviewCandidate: true
  })
  await base.run()
  const source = (await base.app.ports.executions.readExecution(request))!
  await base.app.generation.forkSceneGeneration({
    projectId: request.projectId,
    sceneId: request.sceneId,
    threadId: source.threadId,
    branchId: source.branchId,
    checkpointId: source.checkpointId!,
    operationId: 'fork-settled',
    policy: request.policy,
    reviewCandidate: true,
    decisionChanges: [
      {
        interactionId: source.interaction!.interactionId,
        reply: { kind: 'revise', body: '改成各自回家' }
      }
    ]
  })
  const forkScope = {
    projectId: request.projectId,
    sceneId: request.sceneId,
    threadId: source.threadId,
    operationId: 'fork-settled'
  }
  const snapshotRoot = await newSnapshotRoot('generation-fork-first-write-')
  installSaveFence({
    app: base.app,
    base,
    scope: forkScope,
    snapshotRoot,
    saveNumber: 1,
    when: 'after',
    expectedStepId: 'repair-0'
  })
  await runQueuedIgnoringFailure(base)

  const recoveryCalls = { count: 0 }
  const reopened = await reopen(base, snapshotRoot, failModel(recoveryCalls))
  const stored = (await reopened.app.ports.executions.readExecution(forkScope))!
  expect(stored.state).toBe('running')
  expect(stored.forkRequest).toBeDefined()
  faults.completedWrites = []

  await reopened.app.generation.resumeSceneGeneration({
    ...forkScope,
    branchId: stored.branchId
  })
  await reopened.run()

  const execution = (await reopened.app.ports.executions.readExecution(forkScope))!
  expect(execution.state).toBe('waiting')
  expect(execution.interaction?.kind).toBe('correction')
  expect(execution.candidateSnapshotId).toBeDefined()
  expect(execution.candidateSnapshotId).not.toBe(stored.candidateSnapshotId)
  expect(execution.forkRequest).toBeUndefined()
  expect(execution.fork?.candidateSnapshotId).toBe(source.candidateSnapshotId)
  expect(
    await readFile(workspaceEntry(snapshotRoot, forkScope), 'utf8')
  ).toContain('missing.svg')
  expect(recoveryCalls.count).toBe(0)
  expect(await officialFacts(base)).toEqual(official)
}, 30000)

type ForkWriteCrash = {
  base: GenerationFixture
  official: { entry: string; head: string }
  snapshotRoot: string
  forkScope: ScopeLike
  sourceScope: ScopeLike
  source: SceneGenerationExecution
  firstCandidate: string
}

/** 来源先有两个候选，再从第二个分叉并在首次写入保存后终止。 */
async function prepareForkWriteCrash(operationId: string): Promise<ForkWriteCrash> {
  const base = await generationFixture()
  const official = await officialFacts(base)
  await base.app.generation.generateScene({ ...request, reviewCandidate: true })
  await base.run()
  const first = (await base.app.ports.executions.readExecution(request))!
  const firstCandidate = first.candidateSnapshotId!
  await replyRevise(base.app, first, `source-second-${operationId}`, '把道别写得更克制')
  await base.run()
  const source = (await base.app.ports.executions.readExecution(request))!
  expect(source.candidateSnapshotId).toBeDefined()
  expect(source.candidateSnapshotId).not.toBe(firstCandidate)
  expect(source.state).toBe('waiting')
  await base.app.generation.forkSceneGeneration({
    projectId: request.projectId,
    sceneId: request.sceneId,
    threadId: source.threadId,
    branchId: source.branchId,
    checkpointId: source.checkpointId!,
    operationId,
    policy: request.policy,
    reviewCandidate: true,
    decisionChanges: [
      {
        interactionId: source.interaction!.interactionId,
        reply: { kind: 'revise', body: '改成各自回家' }
      }
    ]
  })
  const forkScope = {
    projectId: request.projectId,
    sceneId: request.sceneId,
    threadId: source.threadId,
    operationId
  }
  const snapshotRoot = await newSnapshotRoot(`generation-fork-proof-${operationId}-`)
  installSaveFence({
    app: base.app,
    base,
    scope: forkScope,
    snapshotRoot,
    saveNumber: 1,
    when: 'after',
    expectedStepId: 'repair-0'
  })
  await runQueuedIgnoringFailure(base)
  return { base, official, snapshotRoot, forkScope, sourceScope: scopeOf(source), source, firstCandidate }
}

/** 重开后改写持久 fork 来源记录，再经公开恢复入口核对恢复结论。 */
async function expectForgedForkRejected(
  crash: ForkWriteCrash,
  forge: (fork: NonNullable<SceneGenerationExecution['fork']>) => SceneGenerationExecution['fork']
): Promise<void> {
  const reopenedRoot = await newSnapshotRoot('generation-fork-forged-')
  await cp(crash.snapshotRoot, reopenedRoot, { recursive: true, force: true })
  const recoveryCalls = { count: 0 }
  const reopened = await reopen(crash.base, reopenedRoot, failModel(recoveryCalls))
  const stored = (await reopened.app.ports.executions.readExecution(crash.forkScope))!
  expect(stored.state).toBe('running')
  expect(stored.fork).toBeDefined()
  const forged = forge(stored.fork!)
  await reopened.app.ports.executions.writeExecution({ ...stored, fork: forged })
  const before = await readFile(workspaceEntry(reopenedRoot, crash.forkScope), 'utf8')

  await reopened.app.generation.resumeSceneGeneration({
    ...crash.forkScope,
    branchId: stored.branchId
  })
  await reopened.run()

  const execution = (await reopened.app.ports.executions.readExecution(crash.forkScope))!
  expect(execution.state).toBe('interrupted')
  expect(execution.interruptReason).toBe('writeUnknown')
  expect(execution.interaction).toBeUndefined()
  expect(execution.failure?.message).toContain('待核对')
  expect(execution.candidateSnapshotId).toMatch(/^[0-9a-f]{40}$/u)
  expect(execution.fork).toEqual(forged)
  expect(recoveryCalls.count).toBe(0)
  expect(await readFile(workspaceEntry(reopenedRoot, crash.forkScope), 'utf8')).toBe(before)
  expect(await reopened.app.ports.executions.readExecution(crash.sourceScope)).toEqual(
    crash.source
  )
  expect(await officialFacts(crash.base)).toEqual(crash.official)
}

it('[P6] 分叉恢复拒绝伪造为同来源另一候选的父修订', async () => {
  const crash = await prepareForkWriteCrash('fork-forged-candidate')
  await expectForgedForkRejected(crash, (fork) => ({
    ...fork,
    candidateSnapshotId: crash.firstCandidate
  }))
}, 30000)

it('[P6] 分叉恢复拒绝跨线程或错分支的来源身份', async () => {
  const crash = await prepareForkWriteCrash('fork-forged-thread')
  await expectForgedForkRejected(crash, (fork) => ({ ...fork, threadId: 'forged-thread' }))
  const branchCrash = await prepareForkWriteCrash('fork-forged-branch')
  await expectForgedForkRejected(branchCrash, (fork) => ({
    ...fork,
    branchId: 'forged-branch'
  }))
}, 45000)

it('[P6] 分叉恢复拒绝错误检查点与其候选绑定', async () => {
  const crash = await prepareForkWriteCrash('fork-forged-checkpoint')
  await expectForgedForkRejected(crash, (fork) => ({
    ...fork,
    checkpointId: piReviewCheckpointId(
      fork.sourceOperationId!,
      crash.firstCandidate
    )
  }))
}, 30000)

it('[P7] 修改已在上一进程写成：重开自动修正失败时说清保留版本与未执行步骤', async () => {
  const revised = validScript.replace('station.svg', 'missing.svg')
  const base = await generationFixture({
    scriptForWrite: (writes) => (writes === 1 ? validScript : revised)
  })
  const official = await officialFacts(base)
  await base.app.generation.generateScene({ ...request, reviewCandidate: true })
  await base.run()
  const reviewed = (await base.app.ports.executions.readExecution(request))!
  expect(reviewed.state).toBe('waiting')
  expect(reviewed.interaction?.kind).toBe('review')
  const beforeRevision = reviewed.candidateSnapshotId!

  const replyId = 'revise-written-before-reopen'
  const scope = scopeOf(reviewed)
  const snapshotRoot = await newSnapshotRoot('generation-revise-write-reopen-')
  installSaveFence({
    app: base.app,
    base,
    scope,
    snapshotRoot,
    saveNumber: 1,
    when: 'after'
  })
  await replyRevise(base.app, reviewed, replyId, '把道别写得更克制')
  await runQueuedIgnoringFailure(base)
  const crashEffects = await effectRecords(snapshotRoot, scope)
  expect(crashEffects).toContainEqual(
    expect.objectContaining({
      stepId: `repair-0-${candidateReplyStepTag(replyId)}`,
      status: 'started'
    })
  )

  const recoveryCalls = { count: 0 }
  const reopened = await reopen(base, snapshotRoot, failModel(recoveryCalls))
  faults.completedWrites = []
  await reopened.app.generation.resumeSceneGeneration(request)
  await reopened.run()

  const execution = (await reopened.app.ports.executions.readExecution(request))!
  expect(execution.state).toBe('waiting')
  expect(execution.interaction?.kind).toBe('correction')
  expect(execution.interaction?.message).toContain('本次修改要求已写入并保留为当前候选')
  expect(execution.interaction?.message).toContain('自动修正尚未执行')
  expect(execution.interaction?.message).not.toContain('本轮修改没有执行')
  expect(execution.candidateSnapshotId).toBeDefined()
  expect(execution.candidateSnapshotId).not.toBe(beforeRevision)
  expect(await readFile(workspaceEntry(snapshotRoot, scope), 'utf8')).toBe(revised)
  expect(await officialFacts(base)).toEqual(official)
  expect(recoveryCalls.count).toBe(1)
  const completed = await effectRecords(snapshotRoot, scope)
  expect(completed).toContainEqual(
    expect.objectContaining({
      stepId: `repair-0-${candidateReplyStepTag(replyId)}`,
      status: 'completed',
      candidateRevision: execution.candidateSnapshotId
    })
  )
  expect(
    completed.filter(
      (effect) => effect.stepId === `repair-0-${candidateReplyStepTag(replyId)}`
    )
  ).toHaveLength(1)
  const status = await reopened.app.status.getSceneGenerationStatus(request)
  expect(status.state).toBe('waiting')
  expect(status.interaction?.message).toContain('本次修改要求已写入并保留为当前候选')
}, 30000)

it('[D/E] 提交后恢复边界清理失败：登记已提交待清理，重试只补清理不重复提交', async () => {
  const base = await generationFixture()
  const commitsBefore = Number(base.git('rev-list', '--count', 'HEAD'))
  await base.app.generation.generateScene(request)
  await base.run()
  const reviewed = (await base.app.ports.executions.readExecution(request))!
  expect(reviewed.state).toBe('waiting')
  expect(reviewed.interaction?.kind).toBe('review')

  const workflow = base.app.ports.workflow
  const originalClear = workflow.clearPauseBoundary.bind(workflow)
  const clear = vi
    .spyOn(workflow, 'clearPauseBoundary')
    .mockRejectedValueOnce(new Error('boundary cleanup failed'))
    .mockImplementation((execution) => originalClear(execution))
  await base.app.generation.replySceneGenerationInteraction({
    projectId: reviewed.projectId,
    sceneId: reviewed.sceneId,
    operationId: reviewed.operationId,
    threadId: reviewed.threadId,
    branchId: reviewed.branchId,
    interactionId: reviewed.interaction!.interactionId,
    checkpointId: reviewed.checkpointId!,
    candidateSnapshotId: reviewed.candidateSnapshotId!,
    replyId: 'accept-before-boundary-cleanup-failure',
    reply: { kind: 'accept' }
  })
  await runQueuedIgnoringFailure(base)

  const committed = (await base.app.ports.executions.readExecution(request))!
  expect(committed.state).toBe('succeeded')
  expect(committed.result?.commitId).toBeDefined()
  expect(committed.workspaceCleanupPending).toBe(false)
  expect(committed.pauseBoundaryCleanupPending).toBe(true)
  expect(committed.failure?.message).toContain('作品已保存')
  expect(committed.failure?.message).toContain('恢复边界清理未完成')
  expect(committed.workspace).toBeUndefined()
  expect((await officialFacts(base)).head).toBe(committed.result!.commitId)
  expect(await readFile(join(base.projectRoot, 'game/scene/start.txt'), 'utf8')).toBe(validScript)
  expect(Number(base.git('rev-list', '--count', 'HEAD'))).toBe(commitsBefore + 1)
  expect(clear).toHaveBeenCalledTimes(1)

  const resumed = await base.app.generation.resumeSceneGeneration(request)
  expect(resumed.state).toBe('succeeded')
  const cleaned = (await base.app.ports.executions.readExecution(request))!
  expect(cleaned.state).toBe('succeeded')
  expect(cleaned.result?.commitId).toBe(committed.result!.commitId)
  expect(cleaned.pauseBoundaryCleanupPending).toBe(false)
  expect(cleaned.workspaceCleanupPending).toBe(false)
  expect(cleaned.failure).toBeUndefined()
  expect(cleaned.workspace).toBeUndefined()
  expect((await officialFacts(base)).head).toBe(committed.result!.commitId)
  expect(Number(base.git('rev-list', '--count', 'HEAD'))).toBe(commitsBefore + 1)
  expect(clear).toHaveBeenCalledTimes(2)
}, 30000)
