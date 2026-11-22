import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createSceneGeneration } from '@bootstrap/sceneGeneration'
import type * as VerifiedFileWriteModule from '@infrastructure/ai/tools/verifiedFileWrite'
import type * as DurableEffectModule from '@infrastructure/workflow/execution/durableEffect'
import {
  generationFixture,
  request,
  validScript,
  type GenerationFixture
} from '../../../../harness/acceptance/support/generationFixture'

const durableWrites = vi.hoisted(() => ({
  failCompleted: false,
  completed: [] as Array<{ stepId: string; questions?: unknown }>
}))

const fileWrites = vi.hoisted(() => ({
  mode: 'none' as 'none' | 'before' | 'after'
}))

vi.mock('@infrastructure/ai/tools/verifiedFileWrite', async (importOriginal) => {
  const actual = await importOriginal<typeof VerifiedFileWriteModule>()
  return {
    ...actual,
    writeVerifiedBytes: async (...args: Parameters<typeof actual.writeVerifiedBytes>) => {
      if (fileWrites.mode === 'before') throw new Error('disk unavailable')
      await actual.writeVerifiedBytes(...args)
      if (fileWrites.mode === 'after') throw new Error('write acknowledgement lost')
    }
  }
})

vi.mock('@infrastructure/workflow/execution/durableEffect', async (importOriginal) => {
  const actual = await importOriginal<typeof DurableEffectModule>()
  return {
    ...actual,
    writeDurableEffect: async (...args: Parameters<typeof actual.writeDurableEffect>) => {
      const record = args[2]
      if (record.status === 'completed') {
        if (durableWrites.failCompleted) throw new Error('completed effect unavailable')
        durableWrites.completed.push({ stepId: record.stepId, questions: record.questions })
      }
      return actual.writeDurableEffect(...args)
    }
  }
})

afterEach(() => {
  durableWrites.failCompleted = false
  durableWrites.completed = []
  fileWrites.mode = 'none'
})

async function effectRecords(
  root: string,
  projectId: string,
  threadId: string,
  operationId: string
): Promise<
  Array<{
    stepId: string
    status: string
    resultDigest?: string
    candidateRevision?: string
    questions?: unknown
  }>
> {
  const directory = join(
    root,
    'state/ai/projects',
    projectId,
    'threads',
    threadId,
    'operations',
    operationId,
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
      async (name) =>
        JSON.parse(await readFile(join(directory, name), 'utf8')) as {
          stepId: string
          status: string
          resultDigest?: string
          candidateRevision?: string
          questions?: unknown
        }
    )
  )
}

/** 候选工作区按操作身份推导；执行记录不持久化该运行时路径。 */
function workspaceEntry(
  root: string,
  operation: { projectId: string; threadId: string; operationId: string }
): string {
  return join(
    root,
    'state/ai/projects',
    operation.projectId,
    'threads',
    operation.threadId,
    'workspaces',
    operation.operationId,
    'game/scene/start.txt'
  )
}

/** 当前 Pi 在候选通过后仍进入审阅等待；显式接受后才进入提交边界。 */
async function acceptReview(f: GenerationFixture): Promise<void> {
  const execution = (await f.app.ports.executions.readExecution(request))!
  if (execution.state !== 'waiting' || !execution.interaction) return
  await f.app.generation.replySceneGenerationInteraction({
    projectId: execution.projectId,
    sceneId: execution.sceneId,
    operationId: execution.operationId,
    threadId: execution.threadId,
    branchId: execution.branchId,
    interactionId: execution.interaction.interactionId,
    checkpointId: execution.interaction.checkpointId,
    candidateSnapshotId: execution.candidateSnapshotId!,
    replyId: 'accept-effect-settlement',
    reply: { kind: 'accept' }
  })
  await f.run()
}

it('写入后的修订保存失败保留 started 与已写草稿，进入待核对', async () => {
  const f = await generationFixture()
  vi.spyOn(f.app.ports.artifacts, 'saveCandidateRevision').mockRejectedValue(
    new Error('revision unavailable')
  )
  const operation = await f.app.generation.generateScene(request)
  await expect(f.run()).rejects.toMatchObject({ code: 4103 })

  const execution = (await f.app.ports.executions.readExecution(request))!
  const effects = await effectRecords(
    f.root,
    operation.projectId,
    operation.threadId,
    operation.operationId
  )
  expect(execution.state).toBe('interrupted')
  expect(execution.interruptReason).toBe('writeUnknown')
  expect(execution.step).toBeUndefined()
  expect(execution.candidateSnapshotId).toBeUndefined()
  expect(effects).toHaveLength(1)
  expect(effects[0]).toMatchObject({ stepId: 'generate-0', status: 'started' })
  expect(effects[0]).not.toHaveProperty('resultDigest')
  expect(effects[0]).not.toHaveProperty('candidateRevision')
  expect(effects.some((effect) => effect.status === 'failed')).toBe(false)
  expect(await readFile(workspaceEntry(f.root, operation), 'utf8')).toBe(validScript)
  expect(await readFile(join(f.projectRoot, 'game/scene/start.txt'), 'utf8')).toBe('say:原稿;')
})

it('模型请求中取消后不遗留 started 副作用，也不提交作品', async () => {
  const f = await generationFixture()
  const { promise: started, resolve: notifyStarted } = Promise.withResolvers<void>()
  const fetcher: typeof fetch = async (_url, init) => {
    const signal = init?.signal
    notifyStarted()
    if (!signal) throw new Error('missing abort signal')
    const { promise, reject } = Promise.withResolvers<Response>()
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    return promise
  }
  const app = await createSceneGeneration({ ...f.config, fetcher })
  const operation = await app.generation.generateScene(request)
  const run = f.run()
  await started
  await app.control.cancelSceneGeneration(request)
  await run

  const execution = (await app.ports.executions.readExecution(request))!
  const effects = await effectRecords(
    f.root,
    operation.projectId,
    operation.threadId,
    operation.operationId
  )
  expect(execution.state).toBe('cancelled')
  expect(execution.step).toBeUndefined()
  expect(effects.some((effect) => effect.status === 'started')).toBe(false)
  expect(effects.some((effect) => effect.status === 'completed')).toBe(false)
  expect(await readFile(join(f.projectRoot, 'game/scene/start.txt'), 'utf8')).toBe('say:原稿;')
})

it('候选已保存且副作用已完成时，后续失败不把完成记录改成失败', async () => {
  const f = await generationFixture()
  const publish = f.app.ports.versions.commitCandidate.bind(f.app.ports.versions)
  vi.spyOn(f.app.ports.versions, 'commitCandidate').mockImplementation(async (...args) => {
    await publish(...args)
    throw new Error('commit acknowledgement lost')
  })
  const operation = await f.app.generation.generateScene(request)
  await f.run()
  await acceptReview(f)

  const execution = (await f.app.ports.executions.readExecution(request))!
  const effects = await effectRecords(
    f.root,
    operation.projectId,
    operation.threadId,
    operation.operationId
  )
  expect(execution.state).toBe('succeeded')
  expect(effects.every((effect) => effect.status === 'completed')).toBe(true)
  expect(effects.find((effect) => effect.stepId === 'generate-0')?.resultDigest).toBeTruthy()
})

it('写入工具未落盘时只把本步 started 结算为失败', async () => {
  const f = await generationFixture()
  fileWrites.mode = 'before'
  const operation = await f.app.generation.generateScene(request)
  await expect(f.run()).rejects.toThrow()
  fileWrites.mode = 'none'

  const execution = (await f.app.ports.executions.readExecution(request))!
  const effects = await effectRecords(
    f.root,
    operation.projectId,
    operation.threadId,
    operation.operationId
  )
  expect(execution.state).toBe('failed')
  expect(execution.step).toBeUndefined()
  expect(effects).toContainEqual(
    expect.objectContaining({ stepId: 'generate-0', status: 'failed' })
  )
  expect(effects.some((effect) => effect.status === 'started')).toBe(false)
  expect(effects.some((effect) => effect.status === 'completed')).toBe(false)
  expect(await readFile(join(f.projectRoot, 'game/scene/start.txt'), 'utf8')).toBe('say:原稿;')
})

it('写入已落盘但工具回执丢失时按同一副作用补完成记录，不重写文件', async () => {
  const f = await generationFixture()
  fileWrites.mode = 'after'
  const operation = await f.app.generation.generateScene(request)
  // 已确认写入后的工具回执失败不再作为后台失败结算。
  await f.run().catch(() => undefined)
  fileWrites.mode = 'none'

  const execution = (await f.app.ports.executions.readExecution(request))!
  const effects = await effectRecords(
    f.root,
    operation.projectId,
    operation.threadId,
    operation.operationId
  )
  expect(execution.state).toBe('waiting')
  expect(execution.interaction?.kind).toBe('review')
  expect(execution.artifactValidation?.issues).toEqual([])
  expect(execution.step).toBeUndefined()
  expect(execution.candidateSnapshotId).toMatch(/^[0-9a-f]{40}$/u)
  const candidate = await f.app.ports.artifacts.readCandidate(
    execution,
    execution.candidateSnapshotId!
  )
  expect(candidate.preview.validationReport.issues).toEqual([])
  expect(effects).toContainEqual(
    expect.objectContaining({
      stepId: 'generate-0',
      status: 'completed',
      candidateRevision: execution.candidateSnapshotId
    })
  )
  expect(effects.find((effect) => effect.stepId === 'generate-0')?.resultDigest).toBeTruthy()
  expect(effects.some((effect) => effect.status === 'started')).toBe(false)
  expect(effects.some((effect) => effect.status === 'failed')).toBe(false)
  const status = await f.app.status.getSceneGenerationStatus(request)
  expect(status.state).toBe('waiting')
  expect(status.interaction?.kind).toBe('review')
  expect(status.canResume).toBe(false)
  expect(await readFile(workspaceEntry(f.root, operation), 'utf8')).toBe(validScript)
  expect(await readFile(join(f.projectRoot, 'game/scene/start.txt'), 'utf8')).toBe('say:原稿;')
})

it('完成记录写失败时保留 started 与已保存修订，进入待核对', async () => {
  const f = await generationFixture()
  durableWrites.failCompleted = true
  const operation = await f.app.generation.generateScene(request)
  await expect(f.run()).rejects.toMatchObject({ code: 4103 })
  durableWrites.failCompleted = false

  const execution = (await f.app.ports.executions.readExecution(request))!
  const effects = await effectRecords(
    f.root,
    operation.projectId,
    operation.threadId,
    operation.operationId
  )
  expect(execution.state).toBe('interrupted')
  expect(execution.interruptReason).toBe('writeUnknown')
  expect(execution.step).toBeUndefined()
  expect(execution.candidateSnapshotId).toMatch(/^[0-9a-f]{40}$/u)
  expect(effects).toHaveLength(1)
  expect(effects[0]).toMatchObject({ stepId: 'generate-0', status: 'started' })
  expect(effects[0]).not.toHaveProperty('resultDigest')
  expect(effects[0]).not.toHaveProperty('candidateRevision')
  expect(effects.some((effect) => effect.status === 'failed')).toBe(false)
  expect(await readFile(join(f.projectRoot, 'game/scene/start.txt'), 'utf8')).toBe('say:原稿;')
})

it('正常写入只写一次完整完成记录，不把题组写进完成记录', async () => {
  const f = await generationFixture()
  const operation = await f.app.generation.generateScene(request)
  await f.run()
  await acceptReview(f)

  const execution = (await f.app.ports.executions.readExecution(request))!
  expect(execution.state).toBe('succeeded')
  const effects = await effectRecords(
    f.root,
    operation.projectId,
    operation.threadId,
    operation.operationId
  )
  const completed = effects.filter(
    (effect) => effect.stepId === 'generate-0' && effect.status === 'completed'
  )
  expect(completed).toHaveLength(1)
  expect(completed[0]?.questions).toEqual([])
  const writes = durableWrites.completed.filter((write) => write.stepId === 'generate-0')
  expect(writes).toHaveLength(1)
  expect(writes[0]?.questions).toHaveLength(0)
})
