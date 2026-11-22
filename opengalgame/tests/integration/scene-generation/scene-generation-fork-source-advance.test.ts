/**
 * 分叉来源在来源分支继续推进后仍可重开。
 *
 * 只用真实装配、真实磁盘工作区、不可变修订与公开 controller/client；
 * 来源先在 R1/C1 被分叉，随后在同一线程推进到 R2/C2；重开分叉仍以 R1 为父，
 * 不读取来源当前检查点，也不清理分叉现场。负例只改写持久分叉字段或删除证据，
 * 断言拒绝且工作区、账本、来源记录和正式作品保持不变。
 */
import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import { cp, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as git from 'isomorphic-git'
import { afterEach, expect, it, vi } from 'vitest'
import { createSceneGeneration, type SceneGenerationServices } from '@bootstrap/sceneGeneration'
import { ManageProjectVersioning } from '@application/project-versioning/services/impl/ManageProjectVersioning'
import type { SceneGenerationExecution } from '@application/scene-generation/models/SceneGenerationExecution'
import type { SceneGenerationRecoveryScopeDTO } from '@application/scene-generation/dto/SceneGenerationDTO'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { DesktopBridge } from '@interfaces/client/DesktopBridge'
import { IpcErrorMapper } from '@interfaces/ipc/errors/IpcErrorMapper'
import { IpcExceptionHandler } from '@interfaces/ipc/errors/IpcExceptionHandler'
import { SceneGenerationClientImpl } from '@interfaces/scene-generation/client/SceneGenerationClientImpl'
import {
  SceneGenerationController,
  type SceneGenerationApplicationGateway
} from '@interfaces/scene-generation/ipc/SceneGenerationController'
import { createProjectVersioningGateways } from '@infrastructure/project-versioning/createProjectVersioningGateways'
import { piReviewCheckpointId } from '@infrastructure/scene-generation/workflow/piReviewCheckpoint'
import {
  generationFixture,
  request,
  type GenerationFixture
} from '../../../../harness/acceptance/support/generationFixture'
import { streamingFetch } from '../ai/streamingFetch'

type ScopeLike = { projectId: string; sceneId: string; threadId: string; operationId: string }
type LocalJobHost = { app: SceneGenerationServices; jobs: Array<() => Promise<void>> }

const extraRoots: string[] = []

const sourceScript =
  'changeBg:station.svg;\n林:末班车快到了，我们明天见。;\nsay:车站的灯亮了。 -clear;\nend;'
const forkFirstScript =
  'changeBg:station.svg;\n林:分叉第一版台词。;\nsay:分叉后的站位。 -clear;\nend;'
const sourceSecondScript =
  'changeBg:station.svg;\n林:来源第二版台词。;\nsay:来源的灯还亮着。 -clear;\nend;'

afterEach(async () => {
  await Promise.all(
    extraRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  )
  vi.restoreAllMocks()
})

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

function writeOnceModel(script: string, calls: { count: number }): typeof fetch {
  return streamingFetch(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: ModelMessage[] }
    const last = body.messages.at(-1)
    calls.count += 1
    return last?.role === 'user'
      ? toolCallResponse(body.messages, script, `write-${calls.count}`)
      : stopResponse()
  })
}

function failModel(calls: { count: number }): typeof fetch {
  return streamingFetch(async () => {
    calls.count += 1
    return Response.json({ error: { message: '重开分叉不应调用模型' } }, { status: 500 })
  })
}

async function newRoot(prefix: string): Promise<string> {
  const work = await mkdtemp(join(tmpdir(), prefix))
  extraRoots.push(work)
  return join(work, 'state')
}

async function openAt(
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
    dispatch: (job) => {
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

async function runQueuedIgnoringFailure(base: GenerationFixture): Promise<void> {
  const job = base.jobs.shift()
  if (!job) throw new Error('缺少任务')
  await job().catch(() => undefined)
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

async function resumeUnfinishedThroughClient(
  app: SceneGenerationServices,
  scope: SceneGenerationRecoveryScopeDTO,
  label?: string
): Promise<void> {
  const logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  }
  const controller = new SceneGenerationController(
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
  const client = new SceneGenerationClientImpl({
    resumeSceneGeneration: (input: unknown) =>
      controller.resume(input, {
        trusted: true,
        requestId: `fork-source-advance-${scope.operationId}`
      })
  } as unknown as DesktopBridge)
  const result = await client.resumeUnfinished(scope)
  expect(result.code, label).toBe(ErrorCodes.success)
  expect(['pending', 'running']).toContain(result.data?.state)
}

function workspaceEntry(userStateRoot: string, scope: ScopeLike): string {
  return join(
    userStateRoot,
    'ai',
    'projects',
    scope.projectId,
    'threads',
    scope.threadId,
    'workspaces',
    scope.operationId,
    'game/scene/start.txt'
  )
}

function effectDirectory(userStateRoot: string, scope: ScopeLike): string {
  return join(
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

async function stateSignature(userStateRoot: string, scope: ScopeLike): Promise<string> {
  const executionPath = join(
    userStateRoot,
    'scene-generation',
    'projects',
    scope.projectId,
    'executions.json'
  )
  return [await digestAt(executionPath), await fenceSignature(userStateRoot, scope)].join('|')
}

/** 工作区字节与副作用账本；不含允许按失败事实更新的执行记录。 */
async function fenceSignature(userStateRoot: string, scope: ScopeLike): Promise<string> {
  const names = (
    await readdir(effectDirectory(userStateRoot, scope)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
  )
    .filter((name) => name.endsWith('.json'))
    .sort()
  return [
    await digestAt(workspaceEntry(userStateRoot, scope)),
    ...(await Promise.all(
      names.map((name) => digestAt(join(effectDirectory(userStateRoot, scope), name)))
    ))
  ].join('|')
}

type StoredExecution = {
  operationId: string
  state: string
  candidateSnapshotId?: string
  checkpointId?: string
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
    // 进度发布器用真实 1.5s 定时器并发写文件；这里必须等真实文件系统让出，
    // 假定时器无法替代跨进程式的复制稳定性检查。
    await new Promise((resolve) => setTimeout(resolve, 60))
  }
  throw new Error(`状态目录未能在持久边界稳定复制：${reason}`)
}

async function snapshotForkFence(
  source: string,
  destination: string,
  scope: ScopeLike,
  expectation: 'no-write' | 'started-write' | 'completed-write'
): Promise<void> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const execution = await copyStableState(source, destination, scope)
    const effects = (
      await readdir(effectDirectory(destination, scope)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return []
        throw error
      })
    ).filter((name) => name.endsWith('.json'))
    const statuses = await Promise.all(
      effects.map(async (name) => {
        const record = JSON.parse(
          await readFile(join(effectDirectory(destination, scope), name), 'utf8')
        ) as { status: string }
        return record.status
      })
    )
    if (execution.state !== 'running') continue
    if (execution.checkpointId !== undefined) continue
    if (expectation === 'no-write' && statuses.length > 0) continue
    if (
      expectation === 'started-write' &&
      statuses.filter((status) => status === 'started').length !== 1
    )
      continue
    if (
      expectation === 'completed-write' &&
      (execution.candidateSnapshotId === undefined ||
        statuses.filter((status) => status === 'completed').length === 0 ||
        statuses.some((status) => status !== 'completed'))
    )
      continue
    return
  }
  throw new Error('状态目录未能在分叉栅栏前稳定复制')
}

type ForkCrash = {
  base: GenerationFixture
  official: { entry: string; head: string }
  crashRoot: string
  forkScope: ScopeLike
  sourceScope: ScopeLike
}

/** 来源 R1/C1 → 建分叉；在分叉首个写入后或首次执行前终止并复制现场。 */
async function prepareForkCrash(
  operationId: string,
  crash: 'before-first-write' | 'after-write-receipt'
): Promise<ForkCrash> {
  const base = await generationFixture({
    scriptForWrite: (writes) => (writes === 1 ? sourceScript : forkFirstScript)
  })
  const official = {
    entry: await readFile(join(base.projectRoot, 'game/scene/start.txt'), 'utf8'),
    head: base.git('rev-parse', 'HEAD')
  }
  await base.app.generation.generateScene({ ...request, reviewCandidate: true })
  await base.run()
  const source = (await base.app.ports.executions.readExecution(request))!
  expect(source.state).toBe('waiting')
  expect(source.checkpointId).toBe(
    piReviewCheckpointId(source.operationId, source.candidateSnapshotId!)
  )
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
  const crashRoot = await newRoot(`fork-source-${operationId}-`)
  if (crash === 'after-write-receipt') {
    const original = base.app.ports.executions.writeExecution.bind(base.app.ports.executions)
    let fired = false
    vi.spyOn(base.app.ports.executions, 'writeExecution').mockImplementation(async (execution) => {
      const candidate = execution.candidateSnapshotId
      // 完成回执已落盘、reading 检查点尚未写入：这是唯一同时有候选写回执和
      // 无检查点的分叉窗口；复制当前持久现场后终止。
      if (
        !fired &&
        execution.operationId === operationId &&
        candidate !== undefined &&
        candidate !== execution.fork?.candidateSnapshotId &&
        execution.checkpointId === piReviewCheckpointId(operationId, candidate)
      ) {
        fired = true
        await snapshotForkFence(base.config.userStateRoot, crashRoot, forkScope, 'completed-write')
        throw new Error('fault fence: process terminated before reading checkpoint')
      }
      return original(execution)
    })
  } else {
    vi.spyOn(base.app.ports.workflow, 'forkGeneration').mockImplementationOnce(async () => {
      await snapshotForkFence(base.config.userStateRoot, crashRoot, forkScope, 'no-write')
      throw new Error('fault fence: process terminated before fork work')
    })
  }
  await runQueuedIgnoringFailure(base)
  return {
    base,
    official,
    crashRoot,
    forkScope,
    sourceScope: {
      projectId: source.projectId,
      sceneId: source.sceneId,
      threadId: source.threadId,
      operationId: source.operationId
    }
  }
}

/** 在崩溃现场的副本上把来源推进到 R2/C2；返回可继续读取的来源事实。 */
async function advanceSource(
  crash: ForkCrash,
  root: string
): Promise<{ source: SceneGenerationExecution; app: LocalJobHost['app'] }> {
  const calls = { count: 0 }
  const advanced = await openAt(crash.base, root, writeOnceModel(sourceSecondScript, calls))
  const before = (await advanced.app.ports.executions.readExecution(crash.sourceScope))!
  expect(before.candidateSnapshotId).toBeDefined()
  await replyRevise(advanced.app, before, 'source-advances-after-fork', '把来源台词改成第二版')
  await advanced.run()
  const source = (await advanced.app.ports.executions.readExecution(crash.sourceScope))!
  expect(source.state).toBe('waiting')
  expect(source.candidateSnapshotId).toBeDefined()
  expect(source.candidateSnapshotId).not.toBe(before.candidateSnapshotId)
  expect(source.checkpointId).toBe(
    piReviewCheckpointId(source.operationId, source.candidateSnapshotId!)
  )
  expect(calls.count).toBeGreaterThan(0)
  expect(await readFile(workspaceEntry(root, crash.sourceScope), 'utf8')).toBe(sourceSecondScript)
  return { source, app: advanced.app }
}

async function officialFacts(base: GenerationFixture): Promise<{ entry: string; head: string }> {
  return {
    entry: await readFile(join(base.projectRoot, 'game/scene/start.txt'), 'utf8'),
    head: base.git('rev-parse', 'HEAD')
  }
}

function recoveryScopeOf(execution: SceneGenerationExecution): SceneGenerationRecoveryScopeDTO {
  return {
    projectId: execution.projectId,
    sceneId: execution.sceneId,
    operationId: execution.operationId,
    threadId: execution.threadId,
    branchId: execution.branchId
  }
}

it('[B2] 来源推进到 R2/C2 后，有写入回执的分叉经公开恢复仍以 R1 为父', async () => {
  const crash = await prepareForkCrash('fork-write-receipt-advance', 'after-write-receipt')
  const root = await newRoot('fork-source-advanced-write-')
  await cp(crash.crashRoot, root, { recursive: true, force: true })
  const advanced = await advanceSource(crash, root)
  const sourceAfter = advanced.source
  const forkBefore = (await advanced.app.ports.executions.readExecution(crash.forkScope))!
  expect(forkBefore.state).toBe('running')
  expect(forkBefore.checkpointId).toBeUndefined()
  expect(forkBefore.candidateSnapshotId).toBeDefined()
  const writtenCandidate = forkBefore.candidateSnapshotId!
  const forkParent = forkBefore.fork!.candidateSnapshotId!
  expect(writtenCandidate).not.toBe(forkParent)
  const workspaceBefore = await readFile(workspaceEntry(root, crash.forkScope), 'utf8')
  const sourceBytes = await readFile(workspaceEntry(root, crash.sourceScope), 'utf8')
  const official = await officialFacts(crash.base)
  expect(official).toEqual(crash.official)

  const calls = { count: 0 }
  const resumed = await openAt(crash.base, root, failModel(calls))
  await resumeUnfinishedThroughClient(resumed.app, recoveryScopeOf(forkBefore))
  await resumed.run()

  const forkAfter = (await resumed.app.ports.executions.readExecution(crash.forkScope))!
  expect(forkAfter.fork?.candidateSnapshotId).toBe(forkParent)
  expect(forkAfter.fork?.sourceOperationId).toBe(sourceAfter.operationId)
  expect(forkAfter.fork?.checkpointId).toBe(
    piReviewCheckpointId(sourceAfter.operationId, forkParent)
  )
  expect(forkAfter.forkRequest).toBeUndefined()
  expect(forkAfter.state).toBe('waiting')
  expect(forkAfter.interaction?.kind).toBe('review')
  expect(forkAfter.candidateSnapshotId).toBe(writtenCandidate)
  expect(forkAfter.checkpointId).toBe(
    piReviewCheckpointId(forkAfter.operationId, forkAfter.candidateSnapshotId!)
  )
  expect(await readFile(workspaceEntry(root, crash.forkScope), 'utf8')).toBe(workspaceBefore)
  expect(await readFile(workspaceEntry(root, crash.sourceScope), 'utf8')).toBe(sourceBytes)
  expect(await resumed.app.ports.executions.readExecution(crash.sourceScope)).toEqual(sourceAfter)
  expect(await officialFacts(crash.base)).toEqual(crash.official)
  expect(calls.count).toBe(0)

  const revisionGitDir = join(
    root,
    'ai',
    'projects',
    request.projectId,
    'threads',
    crash.forkScope.threadId,
    'revisions'
  )
  const commit = await git.readCommit({
    fs,
    gitdir: revisionGitDir,
    oid: forkAfter.candidateSnapshotId!
  })
  expect(commit.commit.parent).toEqual([forkParent])
}, 45000)

it('[B2] 首次分叉执行前崩溃，来源推进后经公开恢复仍复制 R1', async () => {
  const crash = await prepareForkCrash('fork-first-run-advance', 'before-first-write')
  const root = await newRoot('fork-source-advanced-first-')
  await cp(crash.crashRoot, root, { recursive: true, force: true })
  const advanced = await advanceSource(crash, root)
  const sourceAfter = advanced.source
  const forkBefore = (await advanced.app.ports.executions.readExecution(crash.forkScope))!
  expect(forkBefore.state).toBe('running')
  expect(forkBefore.checkpointId).toBeUndefined()
  expect(forkBefore.forkRequest).toBeDefined()
  const copiedCandidate = forkBefore.candidateSnapshotId!
  const official = await officialFacts(crash.base)

  const calls = { count: 0 }
  const resumed = await openAt(crash.base, root, writeOnceModel(forkFirstScript, calls))
  await resumeUnfinishedThroughClient(resumed.app, recoveryScopeOf(forkBefore))
  await resumed.run()

  const forkAfter = (await resumed.app.ports.executions.readExecution(crash.forkScope))!
  expect(forkAfter.fork?.candidateSnapshotId).toBe(copiedCandidate)
  expect(forkAfter.forkRequest).toBeUndefined()
  expect(forkAfter.state).toBe('waiting')
  expect(forkAfter.interaction?.kind).toBe('review')
  expect(forkAfter.candidateSnapshotId).toBeDefined()
  expect(forkAfter.candidateSnapshotId).not.toBe(copiedCandidate)
  expect(forkAfter.checkpointId).toBe(
    piReviewCheckpointId(forkAfter.operationId, forkAfter.candidateSnapshotId!)
  )
  expect(await readFile(workspaceEntry(root, crash.forkScope), 'utf8')).toBe(forkFirstScript)
  expect(await readFile(workspaceEntry(root, crash.sourceScope), 'utf8')).toBe(sourceSecondScript)
  expect(await resumed.app.ports.executions.readExecution(crash.sourceScope)).toEqual(sourceAfter)
  expect(await officialFacts(crash.base)).toEqual(official)
  expect(calls.count).toBeGreaterThan(0)

  const revisionGitDir = join(
    root,
    'ai',
    'projects',
    request.projectId,
    'threads',
    crash.forkScope.threadId,
    'revisions'
  )
  const commit = await git.readCommit({
    fs,
    gitdir: revisionGitDir,
    oid: forkAfter.candidateSnapshotId!
  })
  expect(commit.commit.parent).toEqual([copiedCandidate])
}, 45000)

type ForgedFork = (
  fork: NonNullable<SceneGenerationExecution['fork']>
) => NonNullable<SceneGenerationExecution['fork']>

it('[B2] 错候选/来源/分支/检查点与缺失证据均拒绝重开并保留现场', async () => {
  const crash = await prepareForkCrash('fork-source-negatives', 'after-write-receipt')
  const advancedRoot = await newRoot('fork-source-negatives-advanced-')
  await cp(crash.crashRoot, advancedRoot, { recursive: true, force: true })
  const advanced = await advanceSource(crash, advancedRoot)
  const sourceAfter = advanced.source
  const official = await officialFacts(crash.base)

  const cases: Array<{ name: string; forge?: ForgedFork; removeEvidence?: boolean }> = [
    {
      name: '候选',
      forge: (fork) => ({
        ...fork,
        candidateSnapshotId: sourceAfter.candidateSnapshotId
      })
    },
    {
      name: '来源操作',
      forge: (fork) => ({ ...fork, sourceOperationId: 'forged-source' })
    },
    { name: '来源线程', forge: (fork) => ({ ...fork, threadId: 'forged-thread' }) },
    { name: '来源分支', forge: (fork) => ({ ...fork, branchId: 'forged-branch' }) },
    {
      name: '检查点',
      forge: (fork) => ({
        ...fork,
        checkpointId: piReviewCheckpointId(
          fork.sourceOperationId!,
          sourceAfter.candidateSnapshotId!
        )
      })
    },
    { name: '缺失证据', removeEvidence: true }
  ]

  for (const [index, item] of cases.entries()) {
    const root = await newRoot(`fork-source-negative-${index}-`)
    await cp(advancedRoot, root, { recursive: true, force: true })
    const workspaceBefore = await readFile(workspaceEntry(root, crash.forkScope), 'utf8')
    const sourceBefore = await readFile(workspaceEntry(root, crash.sourceScope), 'utf8')
    const effectsBefore = await fenceSignature(root, crash.forkScope)
    const calls = { count: 0 }
    const reopened = await openAt(crash.base, root, failModel(calls))
    const stored = (await reopened.app.ports.executions.readExecution(crash.forkScope))!
    expect(stored.state).toBe('running')
    if (item.removeEvidence) {
      await rm(
        join(
          root,
          'ai',
          'projects',
          crash.forkScope.projectId,
          'threads',
          crash.forkScope.threadId,
          'operations',
          crash.forkScope.operationId,
          'fork-source.json'
        )
      )
    } else {
      await reopened.app.ports.executions.writeExecution({
        ...stored,
        fork: item.forge!(stored.fork!)
      })
    }

    await resumeUnfinishedThroughClient(reopened.app, recoveryScopeOf(stored), item.name)
    await reopened.run().catch((error: unknown) => {
      throw new Error(`${item.name} 重开失败：${String(error)}`, { cause: error })
    })

    const after = (await reopened.app.ports.executions.readExecution(crash.forkScope))!
    expect(after.state, item.name).toBe('interrupted')
    expect(after.interruptReason, item.name).toBe('writeUnknown')
    expect(after.failure?.message, item.name).toContain('待核对')
    expect(after.interaction, item.name).toBeUndefined()
    expect(await readFile(workspaceEntry(root, crash.forkScope), 'utf8'), item.name).toBe(
      workspaceBefore
    )
    expect(await fenceSignature(root, crash.forkScope), item.name).toBe(effectsBefore)
    expect(await readFile(workspaceEntry(root, crash.sourceScope), 'utf8'), item.name).toBe(
      sourceBefore
    )
    expect(await reopened.app.ports.executions.readExecution(crash.sourceScope), item.name).toEqual(
      sourceAfter
    )
    expect(await officialFacts(crash.base), item.name).toEqual(official)
    expect(calls.count, item.name).toBe(0)
  }
}, 60000)
