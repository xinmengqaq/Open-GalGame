import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createSceneGeneration } from '@bootstrap/sceneGeneration'
import { createWebGalGenerationGraph } from '@infrastructure/scene-generation/workflow/createWebGalGenerationGraph'
import { WebGalGenerationCheckpointSaver } from '@infrastructure/scene-generation/history/WebGalGenerationCheckpoint'
import { langGraphThreadKey } from '@infrastructure/workflow/WorkflowIdentity'
import type * as DurableEffectModule from '@infrastructure/workflow/execution/durableEffect'
import {
  generationFixture,
  request
} from '../../../../harness/acceptance/support/generationFixture'

const durableWrites = vi.hoisted(() => ({
  failCompleted: false,
  completed: [] as Array<{ stepId: string; questions?: unknown }>
}))

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
})

async function effectRecords(
  root: string,
  projectId: string,
  threadId: string,
  operationId: string
) {
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
  const names = (await readdir(directory)).filter((name) => name.endsWith('.json'))
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

async function graphState(
  stateRoot: string,
  artifacts: Parameters<typeof createWebGalGenerationGraph>[0]['artifacts'],
  execution: { projectId: string; threadId: string; branchId: string; operationId: string }
) {
  const graph = createWebGalGenerationGraph({
    stateRoot,
    saver: new WebGalGenerationCheckpointSaver(stateRoot),
    artifacts
  })
  return graph.getState({ configurable: { thread_id: langGraphThreadKey(execution) } })
}

it('写入后的可捕获失败把已开始副作用标为失败，检查点与执行记录一致', async () => {
  const f = await generationFixture()
  vi.spyOn(f.app.ports.artifacts, 'saveCandidateRevision').mockRejectedValue(
    new Error('revision unavailable')
  )
  const operation = await f.app.generation.generateScene(request)
  await expect(f.run()).rejects.toThrow()

  const execution = (await f.app.ports.executions.readExecution(request))!
  const effects = await effectRecords(
    f.root,
    operation.projectId,
    operation.threadId,
    operation.operationId
  )
  expect(effects.some((effect) => effect.status === 'started')).toBe(false)
  expect(effects).toContainEqual(
    expect.objectContaining({ stepId: 'generate-0-initial', status: 'failed' })
  )
  expect(effects.find((effect) => effect.stepId === 'generate-0-initial')).not.toHaveProperty(
    'resultDigest'
  )

  const snapshot = await graphState(
    join(f.config.userStateRoot, 'ai'),
    f.app.ports.artifacts,
    execution
  )
  expect(execution.state).toBe('failed')
  expect(execution.step).toBeUndefined()
  expect(snapshot.values.status).toBe('failed')
  expect(snapshot.values.execution).toMatchObject({ state: 'failed' })
  expect(snapshot.values.execution).not.toHaveProperty('phase')
  expect(await readFile(join(f.projectRoot, 'game/scene/start.txt'), 'utf8')).toBe('say:原稿;')
})

it('模型请求中取消后同样结算已开始副作用，且不提交作品', async () => {
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
  await app.generation.cancelSceneGeneration(request)
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
  expect(effects).toContainEqual(
    expect.objectContaining({ stepId: 'generate-0-initial', status: 'failed' })
  )

  const snapshot = await graphState(
    join(f.config.userStateRoot, 'ai'),
    app.ports.artifacts,
    execution
  )
  expect(snapshot.values.execution).toMatchObject({ state: 'cancelled' })
  expect(snapshot.values.execution).not.toHaveProperty('phase')
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

  const execution = (await f.app.ports.executions.readExecution(request))!
  const effects = await effectRecords(
    f.root,
    operation.projectId,
    operation.threadId,
    operation.operationId
  )
  expect(execution.state).toBe('succeeded')
  expect(effects.every((effect) => effect.status === 'completed')).toBe(true)
  expect(
    effects.find((effect) => effect.stepId === 'generate-0-initial')?.resultDigest
  ).toBeTruthy()
})

it('完成记录写失败时抛错并交给统一结算，不遗留 started', async () => {
  const f = await generationFixture()
  durableWrites.failCompleted = true
  const operation = await f.app.generation.generateScene(request)
  await expect(f.run()).rejects.toThrow('候选完成记录未保存')
  durableWrites.failCompleted = false

  const execution = (await f.app.ports.executions.readExecution(request))!
  const effects = await effectRecords(
    f.root,
    operation.projectId,
    operation.threadId,
    operation.operationId
  )
  expect(execution.state).toBe('failed')
  expect(execution.step).toBeUndefined()
  expect(execution.candidateSnapshotId).toMatch(/^[0-9a-f]{40}$/u)
  expect(effects.some((effect) => effect.status === 'started')).toBe(false)
  expect(effects).toContainEqual(
    expect.objectContaining({ stepId: 'generate-0-initial', status: 'failed' })
  )
  expect(effects.find((effect) => effect.stepId === 'generate-0-initial')).not.toHaveProperty(
    'resultDigest'
  )
})

it('正常写入只写一次完整完成记录，题组不进入完成记录', async () => {
  const f = await generationFixture({
    questionsForWrite: () => [
      {
        prompt: '告别后去哪里？',
        options: [
          { label: '回家', description: '先回家。' },
          { label: '留站台', description: '留在站台。' },
          { label: '不说明', description: '留白。' }
        ]
      }
    ]
  })
  const operation = await f.app.generation.generateScene(request)
  await f.run()

  const execution = (await f.app.ports.executions.readExecution(request))!
  expect(execution.state).toBe('succeeded')
  const effects = await effectRecords(
    f.root,
    operation.projectId,
    operation.threadId,
    operation.operationId
  )
  const completed = effects.filter(
    (effect) => effect.stepId === 'generate-0-initial' && effect.status === 'completed'
  )
  expect(completed).toHaveLength(1)
  // D2：候选写出后不再产生题组；模型给的 questions 不进入完成记录。
  expect(completed[0]?.questions).toEqual([])
  const writes = durableWrites.completed.filter((write) => write.stepId === 'generate-0-initial')
  expect(writes).toHaveLength(1)
  expect(writes[0]?.questions).toHaveLength(0)
})
