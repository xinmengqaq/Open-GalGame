import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

import type { SceneGenerationExecution } from '@application/scene-generation/models/SceneGenerationExecution'
import type { SceneGenerationHistoryReader } from '@application/scene-generation/ports/SceneGenerationHistoryReader'
import { toHistorySummary } from '@application/scene-generation/mapping/SceneGenerationRenderProjection'
import { QuerySceneGenerationHistory } from '@application/scene-generation/services/impl/QuerySceneGenerationHistory'
import { FileSceneGenerationExecutionRepositoryImpl } from '@infrastructure/scene-generation/execution/FileSceneGenerationExecutionRepositoryImpl'
import { planExecutionRecordMigration } from '@infrastructure/scene-generation/execution/ExecutionRecordMigration'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('首访工程自动迁移：当前历史可见集合不变，legacy 只进归档且不可续跑', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'execution-repo-migration-'))
  roots.push(stateRoot)
  const repository = new FileSceneGenerationExecutionRepositoryImpl(stateRoot)
  const dated = currentRecord({
    operationId: 'operation-dated',
    updatedAt: '2026-11-01T02:00:00.000Z',
    createdAt: '2026-11-01T01:00:00.000Z',
    checkpointId: 'checkpoint-dated'
  })
  const later = currentRecord({
    operationId: 'operation-later',
    updatedAt: '2026-11-02T02:00:00.000Z',
    createdAt: '2026-11-02T01:00:00.000Z',
    checkpointId: 'checkpoint-later'
  })
  const undated = currentRecord({
    operationId: 'operation-undated',
    checkpointId: 'checkpoint-undated'
  })
  const legacy = legacyRecord({ operationId: 'operation-legacy' })
  const sourceBytes = Buffer.from(
    JSON.stringify({ version: 3, executions: [dated, undated, later, legacy] })
  )
  const path = await writeProjectDocument(stateRoot, 'project-1', sourceBytes)
  const otherBytes = Buffer.from(
    JSON.stringify({
      version: 3,
      executions: [currentRecord({ projectId: 'project-2', operationId: 'operation-other' })]
    })
  )
  const otherPath = await writeProjectDocument(stateRoot, 'project-2', otherBytes)

  // 迁移前历史可见集合由生产投影从源记录直接算出，作为迁移后对照。
  const plan = planExecutionRecordMigration(sourceBytes, 'project-1')
  const expectedHistory = historyOperationIds(plan.currentExecutions)
  expect(expectedHistory).toEqual(['operation-later', 'operation-dated'])

  const history = new QuerySceneGenerationHistory(unusedHistoryReader(), repository)
  const summaries = await history.listSceneGenerationHistoryForScene({
    projectId: 'project-1',
    sceneId: 'scene-1',
    limit: 20
  })
  expect(summaries.map((summary) => summary.operationId)).toEqual(expectedHistory)
  expect(summaries.map((summary) => summary.createdAt)).toEqual([
    '2026-11-02T02:00:00.000Z',
    '2026-11-01T02:00:00.000Z'
  ])

  await expect(
    repository.readExecution({
      projectId: 'project-1',
      sceneId: 'scene-1',
      operationId: 'operation-legacy'
    })
  ).resolves.toBeNull()
  await expect(
    repository.readExecution({
      projectId: 'project-1',
      sceneId: 'scene-1',
      operationId: 'operation-dated'
    })
  ).resolves.toMatchObject({
    operationId: 'operation-dated',
    createdAt: '2026-11-01T01:00:00.000Z',
    updatedAt: '2026-11-01T02:00:00.000Z'
  })
  await expect(
    repository.findActiveExecution({
      projectId: 'project-1',
      sceneId: 'scene-1',
      threadId: 'thread-legacy'
    })
  ).resolves.toBeNull()
  await expect(
    repository.listThread({
      projectId: 'project-1',
      sceneId: 'scene-1',
      threadId: 'thread-legacy'
    })
  ).resolves.toEqual([])
  await expect(
    repository.writeExecution({
      ...legacyExecution(),
      projectId: 'project-1',
      sceneId: 'scene-1'
    })
  ).rejects.toMatchObject({ code: 4102 })

  const saved = JSON.parse(await readFile(path, 'utf8')) as {
    version: number
    executions: Array<{ operationId: string }>
  }
  expect(saved.version).toBe(7)
  expect(saved.executions.map((item) => item.operationId)).toEqual([
    'operation-dated',
    'operation-undated',
    'operation-later'
  ])
  expect(
    (
      await repository.listSceneExecutions({
        projectId: 'project-1',
        sceneId: 'scene-1',
        limit: 20
      })
    ).map((execution) => execution.operationId)
  ).toEqual(['operation-dated', 'operation-later'])
  await expect(repository.findLatestSceneExecution('project-1', 'scene-1')).resolves.toMatchObject({
    operationId: 'operation-later'
  })

  const archiveDirectory = join(
    stateRoot,
    'scene-generation/projects/project-1/legacy-executions',
    createHash('sha256').update(sourceBytes).digest('hex')
  )
  expect(await readFile(join(archiveDirectory, 'source.json'))).toEqual(sourceBytes)
  const manifest = JSON.parse(await readFile(join(archiveDirectory, 'manifest.json'), 'utf8')) as {
    counts: Record<string, number>
    legacyRecords: Array<{ operationId: string }>
  }
  expect(manifest.counts).toEqual({ total: 4, current: 3, legacy: 1 })
  expect(manifest.legacyRecords.map((record) => record.operationId)).toEqual(['operation-legacy'])

  // 未访问工程不扫描：字节不变，且没有生成归档目录。
  expect(await readFile(otherPath)).toEqual(otherBytes)
  await expect(
    readdir(join(stateRoot, 'scene-generation/projects/project-2/legacy-executions'))
  ).rejects.toMatchObject({ code: 'ENOENT' })

  // 迁移后当前记录仍可正常写入，legacy 不会再回到产品文件。
  const created = await repository.createExecution({
    ...currentExecution(),
    operationId: 'operation-new',
    threadId: 'thread-new',
    branchId: 'branch-new'
  })
  const written = await repository.writeExecution({ ...created, state: 'running' })
  expect(written.createdAt).toBe(created.createdAt)
  const afterWrite = JSON.parse(await readFile(path, 'utf8')) as {
    executions: Array<{ operationId: string }>
  }
  expect(afterWrite.executions.map((item) => item.operationId)).toEqual([
    'operation-dated',
    'operation-undated',
    'operation-later',
    'operation-new'
  ])
})

it('归档失败时产品读取明确拒绝且源不变，修复归档后重试成功', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'execution-repo-migration-failure-'))
  roots.push(stateRoot)
  const repository = new FileSceneGenerationExecutionRepositoryImpl(stateRoot)
  const legacy = legacyRecord({ operationId: 'operation-legacy' })
  const sourceBytes = Buffer.from(JSON.stringify({ version: 1, executions: [legacy] }))
  const path = await writeProjectDocument(stateRoot, 'project-1', sourceBytes)
  const archiveDirectory = join(
    stateRoot,
    'scene-generation/projects/project-1/legacy-executions',
    createHash('sha256').update(sourceBytes).digest('hex')
  )
  await mkdir(archiveDirectory, { recursive: true })
  await writeFile(join(archiveDirectory, 'source.json'), 'broken-source')
  await writeFile(join(archiveDirectory, 'manifest.json'), '{"formatVersion":1}')

  const refused = {
    code: 5103,
    message: '执行记录迁移未完成，拒绝读取未迁移记录'
  }
  await expect(
    repository.readExecution({
      projectId: 'project-1',
      sceneId: 'scene-1',
      operationId: 'operation-legacy'
    })
  ).rejects.toMatchObject(refused)
  await expect(
    repository.listSceneExecutions({ projectId: 'project-1', sceneId: 'scene-1', limit: 20 })
  ).rejects.toMatchObject(refused)
  await expect(
    repository.writeExecution({
      ...legacyExecution(),
      projectId: 'project-1',
      sceneId: 'scene-1'
    })
  ).rejects.toMatchObject(refused)
  await expect(
    repository.createExecution({
      ...currentExecution(),
      operationId: 'operation-new',
      threadId: 'thread-new',
      branchId: 'branch-new'
    })
  ).rejects.toMatchObject(refused)
  expect(await readFile(path)).toEqual(sourceBytes)
  expect(await readFile(join(archiveDirectory, 'source.json'))).toEqual(
    Buffer.from('broken-source')
  )

  // 修复归档占用后，同一次进程内下一次读取重试并成功迁移。
  await rm(archiveDirectory, { recursive: true, force: true })
  await expect(
    repository.readExecution({
      projectId: 'project-1',
      sceneId: 'scene-1',
      operationId: 'operation-legacy'
    })
  ).resolves.toBeNull()
  const saved = JSON.parse(await readFile(path, 'utf8')) as {
    version: number
    executions: unknown[]
  }
  expect(saved.version).toBe(7)
  expect(saved.executions).toEqual([])
  expect(await readFile(join(archiveDirectory, 'source.json'))).toEqual(sourceBytes)
})

function historyOperationIds(executions: readonly SceneGenerationExecution[]): string[] {
  const projected = executions.flatMap((execution, appendIndex) => {
    const createdAt = execution.updatedAt ?? execution.timeline?.at(-1)?.createdAt
    const summary = createdAt ? toHistorySummary(execution, createdAt) : undefined
    return summary ? [{ summary, appendIndex }] : []
  })
  projected.sort((left, right) => {
    if (left.summary.createdAt !== right.summary.createdAt)
      return left.summary.createdAt < right.summary.createdAt ? 1 : -1
    return right.appendIndex - left.appendIndex
  })
  return projected.map((item) => item.summary.operationId)
}

function unusedHistoryReader(): SceneGenerationHistoryReader {
  return {
    listHistory: async () => ({ branches: [], checkpoints: [] }),
    readCheckpoint: async () => {
      throw new Error('本测试只读取场景历史')
    }
  } as unknown as SceneGenerationHistoryReader
}

function currentExecution(): SceneGenerationExecution {
  return {
    projectId: 'project-1',
    sceneId: 'scene-1',
    operationId: 'operation-current',
    threadId: 'thread-current',
    branchId: 'branch-current',
    fingerprint: 'fingerprint-current',
    source: {
      projectId: 'project-1',
      sceneId: 'scene-1',
      projectRoot: '/project',
      sceneDirectory: 'game/scene',
      entryFile: 'start.txt'
    },
    inputSnapshot: {
      canvasId: 'canvas-1',
      arrangementVersion: 'v1',
      assets: [],
      documents: [],
      prompts: [],
      fieldBindings: [],
      relations: [],
      confirmedControls: []
    },
    policy: { maxCorrections: 1 },
    reviewCandidate: false,
    baseline: { commitId: 'base', affectedFiles: [], lockState: 'unlocked' },
    state: 'pending',
    step: 'preparing',
    attempt: 0,
    sequence: 0,
    budget: { correctionsUsed: 0, modelCallsUsed: 0, toolCallsUsed: 0, activeElapsedMs: 0 },
    replies: []
  }
}

function currentRecord(
  overrides: Partial<SceneGenerationExecution> = {}
): SceneGenerationExecution {
  return {
    ...currentExecution(),
    state: 'succeeded',
    step: undefined,
    ...overrides
  }
}

function legacyRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectId: 'project-1',
    sceneId: 'scene-1',
    operationId: 'operation-legacy',
    threadId: 'thread-legacy',
    branchId: 'branch-legacy',
    fingerprint: 'fingerprint-legacy',
    state: 'succeeded',
    inputSnapshot: { prompts: [{ id: 'story', sourceId: 'story', body: '旧正文' }] },
    ...overrides
  }
}

function legacyExecution(): SceneGenerationExecution {
  return {
    ...currentExecution(),
    operationId: 'operation-legacy',
    threadId: 'thread-legacy',
    branchId: 'branch-legacy',
    fingerprint: 'fingerprint-legacy'
  }
}

async function writeProjectDocument(
  stateRoot: string,
  projectId: string,
  bytes: Buffer
): Promise<string> {
  const directory = join(stateRoot, 'scene-generation/projects', projectId)
  const path = join(directory, 'executions.json')
  await mkdir(directory, { recursive: true })
  await writeFile(path, bytes)
  return path
}
