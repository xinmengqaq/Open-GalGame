import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

import type { SceneGenerationExecution } from '@application/scene-generation/models/SceneGenerationExecution'
import {
  executionDocumentSchema,
  executionFromDocument
} from '@infrastructure/scene-generation/execution/SceneGenerationExecutionDocument'
import {
  isSupportedExecutionEnvelopeVersion,
  LEGACY_EXECUTION_RECORD_REASONS,
  legacyExecutionRecordReason,
  legacyExecutionRecordTimeFacts,
  migrateExecutionDocument
} from '@infrastructure/scene-generation/execution/LegacyExecutionRecordDocument'
import {
  writeExecutionRecordArchive
} from '@infrastructure/scene-generation/execution/LegacyExecutionRecordArchive'
import {
  migrateExecutionRecordFile,
  planExecutionRecordMigration,
  readCurrentExecutionRecordFile
} from '@infrastructure/scene-generation/execution/ExecutionRecordMigration'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it('当前 v7 且迁移不改变记录时零写，也不创建归档', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'execution-migration-current-'))
  roots.push(stateRoot)
  const path = await writeDocument(stateRoot, {
    version: 7,
    executions: [
      {
        ...currentExecution(),
        operationId: 'operation-current',
        state: 'succeeded',
        step: undefined,
        createdAt: '2026-11-14T01:00:00.000Z',
        updatedAt: '2026-11-14T02:00:00.000Z',
        timeline: [
          {
            entryId: 'entry-1',
            sequence: 1,
            createdAt: '2026-11-14T02:00:00.000Z',
            kind: 'stage',
            stage: 'completed',
            message: '已完成'
          }
        ]
      }
    ]
  })
  const before = await readFile(path)
  const beforeStat = await stat(path)

  const plan = planExecutionRecordMigration(before, 'project-1')
  expect(plan.rewrite).toBe(false)
  expect(plan.counts).toEqual({ total: 1, current: 1, legacy: 0 })

  const run = await migrateExecutionRecordFile({
    stateRoot,
    projectId: 'project-1',
    relativePath: plan.relativePath,
    documentPath: path,
    bytes: before
  })
  expect(run.outcome).toBe('unchanged')
  expect(run.plan.currentExecutions.map((execution) => execution.operationId)).toEqual([
    'operation-current'
  ])
  expect(await readFile(path)).toEqual(before)
  expect((await stat(path)).mtimeMs).toBe(beforeStat.mtimeMs)
  await expect(
    readdir(join(stateRoot, 'scene-generation/projects/project-1/legacy-executions'))
  ).rejects.toMatchObject({ code: 'ENOENT' })
})

it('v1–7 可当前化记录按既有映射升到 v7，归档保留迁移前字节', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'execution-migration-v3-'))
  roots.push(stateRoot)
  const dated = {
    ...currentExecution(),
    operationId: 'operation-dated',
    state: 'succeeded',
    step: undefined,
    createdAt: '2026-10-18T00:00:00.000Z',
    updatedAt: '2026-10-18T01:00:00.000Z'
  }
  const undated = {
    ...currentExecution(),
    operationId: 'operation-undated',
    state: 'pending',
    step: 'preparing'
  }
  const phased = {
    ...currentExecution(),
    operationId: 'operation-phased',
    state: 'running',
    step: undefined,
    phase: 'reading'
  }
  const sourceBytes = Buffer.from(
    JSON.stringify({ version: 3, executions: [dated, undated, phased] })
  )
  const path = await writeDocumentBytes(stateRoot, sourceBytes)

  const plan = planExecutionRecordMigration(sourceBytes, 'project-1')
  expect(plan.rewrite).toBe(true)
  expect(plan.counts).toEqual({ total: 3, current: 3, legacy: 0 })

  const run = await migrateExecutionRecordFile({
    stateRoot,
    projectId: 'project-1',
    relativePath: plan.relativePath,
    documentPath: path,
    bytes: sourceBytes
  })
  expect(run.outcome).toBe('migrated')
  expect(run.plan.currentExecutions).toHaveLength(3)

  const savedBytes = await readFile(path)
  const saved = JSON.parse(savedBytes.toString('utf8')) as {
    version: number
    executions: Array<Record<string, unknown>>
  }
  expect(saved.version).toBe(7)
  expect(saved.executions.map((item) => item.operationId)).toEqual([
    'operation-dated',
    'operation-undated',
    'operation-phased'
  ])
  expect(saved.executions[0]?.timeline).toEqual([
    {
      entryId: 'operation-dated:migrated',
      sequence: 0,
      createdAt: '2026-10-18T01:00:00.000Z',
      kind: 'stage',
      stage: 'completed',
      message: '已恢复此前保存的生成记录'
    }
  ])
  expect(saved.executions[1]?.createdAt).toBeUndefined()
  expect(saved.executions[2]?.step).toBe('reading')
  expect(saved.executions[2]).not.toHaveProperty('phase')

  const archiveDirectory = join(
    stateRoot,
    'scene-generation/projects/project-1/legacy-executions',
    createHash('sha256').update(sourceBytes).digest('hex')
  )
  expect(await readFile(join(archiveDirectory, 'source.json'))).toEqual(sourceBytes)
  const manifest = JSON.parse(await readFile(join(archiveDirectory, 'manifest.json'), 'utf8')) as {
    source: { envelopeVersion: number; sizeBytes: number; sha256: string }
    target: { envelopeVersion: number; sha256: string }
    counts: { total: number; current: number; legacy: number }
    legacyRecords: unknown[]
  }
  expect(manifest.source.envelopeVersion).toBe(3)
  expect(manifest.source.sizeBytes).toBe(sourceBytes.byteLength)
  expect(manifest.source.sha256).toBe(createHash('sha256').update(sourceBytes).digest('hex'))
  expect(manifest.target.envelopeVersion).toBe(7)
  expect(manifest.target.sha256).toBe(createHash('sha256').update(savedBytes).digest('hex'))
  expect(manifest.counts).toEqual({ total: 3, current: 3, legacy: 0 })
  expect(manifest.legacyRecords).toEqual([])
  expect(planExecutionRecordMigration(savedBytes, 'project-1').rewrite).toBe(false)
})

it('只能归档的旧记录移出产品文件，按已有时间事实记录原因并复用归档', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'execution-migration-legacy-'))
  roots.push(stateRoot)
  const current = {
    ...currentExecution(),
    operationId: 'operation-current',
    state: 'succeeded',
    step: undefined,
    createdAt: '2026-10-18T00:00:00.000Z',
    updatedAt: '2026-10-18T01:00:00.000Z'
  }
  const noTime = legacyRecord({ operationId: 'operation-legacy-no-time' })
  const incomplete = legacyRecord({
    operationId: 'operation-legacy-incomplete',
    createdAt: '2026-09-01T00:00:00.000Z'
  })
  const sourceBytes = Buffer.from(
    JSON.stringify({ version: 1, executions: [current, noTime, incomplete] })
  )
  const path = await writeDocumentBytes(stateRoot, sourceBytes)
  const plan = planExecutionRecordMigration(sourceBytes, 'project-1')
  expect(plan.counts).toEqual({ total: 3, current: 1, legacy: 2 })
  expect(plan.legacyRecords.map((record) => record.reason)).toEqual([
    'missing-record-time',
    'current-schema-incomplete'
  ])

  const run = await migrateExecutionRecordFile({
    stateRoot,
    projectId: 'project-1',
    relativePath: plan.relativePath,
    documentPath: path,
    bytes: sourceBytes
  })
  expect(run.outcome).toBe('migrated')
  expect(run.archiveReused).toBe(false)
  const saved = JSON.parse(await readFile(path, 'utf8')) as {
    version: number
    executions: Array<{ operationId: string }>
  }
  expect(saved.version).toBe(7)
  expect(saved.executions.map((item) => item.operationId)).toEqual(['operation-current'])

  const archiveDirectory = join(
    stateRoot,
    'scene-generation/projects/project-1/legacy-executions',
    createHash('sha256').update(sourceBytes).digest('hex')
  )
  expect(await readFile(join(archiveDirectory, 'source.json'))).toEqual(sourceBytes)
  const manifestPath = join(archiveDirectory, 'manifest.json')
  const manifestBytes = await readFile(manifestPath)
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
    counts: { total: number; current: number; legacy: number }
    legacyRecords: Array<Record<string, unknown>>
  }
  expect(manifest.counts).toEqual({ total: 3, current: 1, legacy: 2 })
  expect(manifest.legacyRecords).toEqual([
    legacyManifestRecord(noTime, 'missing-record-time'),
    legacyManifestRecord(incomplete, 'current-schema-incomplete')
  ])

  await writeFile(path, sourceBytes)
  const again = await migrateExecutionRecordFile({
    stateRoot,
    projectId: 'project-1',
    relativePath: plan.relativePath,
    documentPath: path,
    bytes: sourceBytes
  })
  expect(again.outcome).toBe('migrated')
  expect(again.archiveReused).toBe(true)
  expect(await readFile(manifestPath)).toEqual(manifestBytes)
})

it('旧等待记录未证明可迁移时整批阻断，旧版结算为终态后正常迁移', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'execution-migration-blocked-'))
  roots.push(stateRoot)
  const current = {
    ...currentExecution(),
    operationId: 'operation-current',
    state: 'succeeded',
    step: undefined,
    updatedAt: '2026-10-18T01:00:00.000Z',
    createdAt: '2026-10-18T00:00:00.000Z'
  }
  const waiting = legacyRecord({
    operationId: 'operation-waiting-repair',
    state: 'waiting',
    checkpointId: 'checkpoint-waiting',
    candidateSnapshotId: 'candidate-waiting',
    interaction: {
      interactionId: 'interaction-waiting',
      checkpointId: 'checkpoint-waiting',
      kind: 'review',
      message: '请审阅当前候选',
      options: [],
      allowedReplies: ['accept', 'revise', 'discard']
    }
  })
  const settledLegacy = legacyRecord({ operationId: 'operation-legacy-terminal', state: 'failed' })
  const sourceBytes = Buffer.from(
    JSON.stringify({ version: 1, executions: [current, waiting, settledLegacy] })
  )
  const path = await writeDocumentBytes(stateRoot, sourceBytes)
  const sourceStat = await stat(path)
  const archiveRoot = join(
    stateRoot,
    'scene-generation/projects/project-1/legacy-executions'
  )

  const plan = planExecutionRecordMigration(sourceBytes, 'project-1')
  expect(plan.blocked).toBe(true)
  expect(plan.counts).toEqual({ total: 3, current: 1, legacy: 2 })
  expect(plan.blockedRecords).toEqual([
    {
      projectId: 'project-1',
      sceneId: 'scene-1',
      operationId: 'operation-waiting-repair',
      threadId: 'thread-legacy',
      branchId: 'branch-legacy',
      fingerprint: 'fingerprint-legacy',
      state: 'waiting',
      reason: 'missing-record-time'
    }
  ])

  await expect(
    migrateExecutionRecordFile({
      stateRoot,
      projectId: 'project-1',
      relativePath: plan.relativePath,
      documentPath: path,
      bytes: sourceBytes
    })
  ).resolves.toMatchObject({
    outcome: 'blocked',
    error: expect.stringContaining('operation-waiting-repair')
  })
  expect(await readFile(path)).toEqual(sourceBytes)
  expect((await stat(path)).mtimeMs).toBe(sourceStat.mtimeMs)
  await expect(readdir(archiveRoot)).rejects.toMatchObject({ code: 'ENOENT' })

  // 重复读取/运行仍只阻断，不留下归档、不改变源文件。
  const repeated = await migrateExecutionRecordFile({
    stateRoot,
    projectId: 'project-1',
    relativePath: plan.relativePath,
    documentPath: path,
    bytes: await readFile(path)
  })
  expect(repeated.outcome).toBe('blocked')
  await expect(
    readCurrentExecutionRecordFile({
      stateRoot,
      projectId: 'project-1',
      relativePath: plan.relativePath,
      documentPath: path
    })
  ).rejects.toMatchObject({
    code: 5103,
    message: expect.stringContaining('旧版生成记录仍有未结束操作')
  })
  expect(await readFile(path)).toEqual(sourceBytes)
  await expect(readdir(archiveRoot)).rejects.toMatchObject({ code: 'ENOENT' })

  // 模拟旧版明确结算：只把状态改为终态，随后同一文件的旧记录可正常归档。
  const settled = JSON.parse(sourceBytes.toString('utf8')) as {
    executions: Array<Record<string, unknown>>
  }
  settled.executions[1] = { ...settled.executions[1], state: 'failed' }
  const settledBytes = Buffer.from(JSON.stringify(settled))
  await writeFile(path, settledBytes)
  const settledPlan = planExecutionRecordMigration(settledBytes, 'project-1')
  expect(settledPlan.blocked).toBe(false)
  const settledRun = await migrateExecutionRecordFile({
    stateRoot,
    projectId: 'project-1',
    relativePath: settledPlan.relativePath,
    documentPath: path,
    bytes: settledBytes
  })
  expect(settledRun.outcome).toBe('migrated')
  const saved = JSON.parse(await readFile(path, 'utf8')) as {
    version: number
    executions: Array<{ operationId: string }>
  }
  expect(saved.version).toBe(7)
  expect(saved.executions.map((item) => item.operationId)).toEqual(['operation-current'])
  const archiveDirectory = join(
    archiveRoot,
    createHash('sha256').update(settledBytes).digest('hex')
  )
  expect(await readFile(join(archiveDirectory, 'source.json'))).toEqual(settledBytes)
  const manifest = JSON.parse(await readFile(join(archiveDirectory, 'manifest.json'), 'utf8')) as {
    legacyRecords: Array<{ operationId: string; state: string }>
  }
  expect(manifest.legacyRecords.map((record) => record.operationId)).toEqual([
    'operation-waiting-repair',
    'operation-legacy-terminal'
  ])
  expect(manifest.legacyRecords.every((record) => record.state === 'failed')).toBe(true)
})

it('归档写入拒绝未结束旧记录，不创建归档目录', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'execution-archive-unfinished-'))
  roots.push(stateRoot)
  const sourceBytes = Buffer.from(
    JSON.stringify({ version: 1, executions: [legacyRecord({ state: 'waiting' })] })
  )
  await expect(
    writeExecutionRecordArchive({
      stateRoot,
      projectId: 'project-1',
      relativePath: 'scene-generation/projects/project-1/executions.json',
      sourceBytes,
      sourceSha256: createHash('sha256').update(sourceBytes).digest('hex'),
      envelopeVersion: 1,
      modifiedAt: '2026-10-18T00:00:00.000Z',
      targetSha256: createHash('sha256').update(Buffer.from('{}')).digest('hex'),
      counts: { total: 1, current: 0, legacy: 1 },
      legacyRecords: [
        {
          ...legacyRecord({ state: 'waiting' }),
          hasCreatedAt: false,
          hasUpdatedAt: false,
          hasTimeline: false,
          rawSha256: createHash('sha256')
            .update(JSON.stringify(legacyRecord({ state: 'waiting' })))
            .digest('hex'),
          reason: 'missing-record-time'
        }
      ]
    })
  ).rejects.toThrowError(/未结束的旧记录不能归档升级/)
  await expect(
    readdir(join(stateRoot, 'scene-generation/projects/project-1/legacy-executions'))
  ).rejects.toMatchObject({ code: 'ENOENT' })
})

it('无法分类的记录或未知信封版本严格中止，不写产品文件也不写归档', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'execution-migration-unreadable-'))
  roots.push(stateRoot)
  const unreadableBytes = Buffer.from(
    JSON.stringify({ version: 3, executions: [currentExecution(), { foo: 'bar' }] })
  )
  const unreadablePath = await writeDocumentBytes(stateRoot, unreadableBytes, 'project-1')
  expect(() => planExecutionRecordMigration(unreadableBytes, 'project-1')).toThrowError(
    /场景生成执行记录读写失败/
  )
  await expect(
    migrateExecutionRecordFile({
      stateRoot,
      projectId: 'project-1',
      relativePath: 'scene-generation/projects/project-1/executions.json',
      documentPath: unreadablePath,
      bytes: unreadableBytes
    })
  ).rejects.toThrowError(/场景生成执行记录读写失败/)
  expect(await readFile(unreadablePath)).toEqual(unreadableBytes)

  const unsupportedBytes = Buffer.from(JSON.stringify({ version: 8, executions: [] }))
  const unsupportedPath = await writeDocumentBytes(stateRoot, unsupportedBytes, 'project-2')
  expect(() => planExecutionRecordMigration(unsupportedBytes, 'project-2')).toThrowError(
    /执行记录信封版本不受支持/
  )
  await expect(
    migrateExecutionRecordFile({
      stateRoot,
      projectId: 'project-2',
      relativePath: 'scene-generation/projects/project-2/executions.json',
      documentPath: unsupportedPath,
      bytes: unsupportedBytes
    })
  ).rejects.toThrowError(/执行记录信封版本不受支持/)
  expect(await readFile(unsupportedPath)).toEqual(unsupportedBytes)

  for (const projectId of ['project-1', 'project-2']) {
    await expect(
      readdir(join(stateRoot, 'scene-generation/projects', projectId, 'legacy-executions'))
    ).rejects.toMatchObject({ code: 'ENOENT' })
  }
})

it('损坏的既有归档不被覆盖，产品读取明确拒绝，修复后重试成功', async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'execution-migration-corrupt-'))
  roots.push(stateRoot)
  const legacy = legacyRecord({ operationId: 'operation-legacy' })
  const sourceBytes = Buffer.from(JSON.stringify({ version: 1, executions: [legacy] }))
  const path = await writeDocumentBytes(stateRoot, sourceBytes)
  const archiveDirectory = join(
    stateRoot,
    'scene-generation/projects/project-1/legacy-executions',
    createHash('sha256').update(sourceBytes).digest('hex')
  )
  await mkdir(archiveDirectory, { recursive: true })
  await writeFile(join(archiveDirectory, 'source.json'), 'not-the-source')
  await writeFile(join(archiveDirectory, 'manifest.json'), '{"formatVersion":1}')

  const run = await migrateExecutionRecordFile({
    stateRoot,
    projectId: 'project-1',
    relativePath: 'scene-generation/projects/project-1/executions.json',
    documentPath: path,
    bytes: sourceBytes
  })
  expect(run.outcome).toBe('failed')
  expect(run.plan.legacyRecords.map((record) => record.fact.operationId)).toEqual([
    'operation-legacy'
  ])
  expect(run.error).toBeTruthy()
  expect(await readFile(path)).toEqual(sourceBytes)
  expect(await readFile(join(archiveDirectory, 'source.json'))).toEqual(
    Buffer.from('not-the-source')
  )

  await expect(
    readCurrentExecutionRecordFile({
      stateRoot,
      projectId: 'project-1',
      relativePath: 'scene-generation/projects/project-1/executions.json',
      documentPath: path
    })
  ).rejects.toMatchObject({
    code: 5103,
    message: '执行记录迁移未完成，拒绝读取未迁移记录'
  })
  expect(await readFile(path)).toEqual(sourceBytes)

  await rm(archiveDirectory, { recursive: true, force: true })
  await expect(
    readCurrentExecutionRecordFile({
      stateRoot,
      projectId: 'project-1',
      relativePath: 'scene-generation/projects/project-1/executions.json',
      documentPath: path
    })
  ).resolves.toEqual([])
  const saved = JSON.parse(await readFile(path, 'utf8')) as {
    version: number
    executions: unknown[]
  }
  expect(saved.version).toBe(7)
  expect(saved.executions).toEqual([])
  expect(await readFile(join(archiveDirectory, 'source.json'))).toEqual(sourceBytes)
})

it('旧文档映射只在迁移模块：当前 schema 与检查点读取拒绝旧字段', () => {
  const legacy = {
    ...currentExecution(),
    operationId: 'operation-legacy-mapping',
    state: 'running',
    step: undefined,
    phase: 'reading',
    inputSnapshot: {
      ...currentExecution().inputSnapshot,
      assets: [
        {
          assetId: 'card-audio',
          sourceId: 'audio-source',
          name: '下压音',
          relativePath: 'assets/bgm/duck.ogg',
          purpose: 'music',
          description: '下压音效',
          usage: { targetIds: [] }
        }
      ],
      prompts: [
        {
          id: 'prompt-1',
          title: '提示',
          body: '用下压音',
          scopes: [{ kind: 'scene' }],
          references: [
            { cardId: 'card-audio', kind: 'audio', displayName: '下压音', role: 'music' }
          ],
          usage: { targetIds: [] }
        }
      ]
    }
  }
  expect(executionDocumentSchema.safeParse(legacy).success).toBe(false)
  expect(() => executionFromDocument(legacy)).toThrowError(/场景生成执行事实格式不兼容或不完整/)

  const migrated = migrateExecutionDocument(legacy) as Record<string, unknown>
  expect(migrated).not.toHaveProperty('phase')
  expect(migrated.step).toBe('reading')
  const parsed = executionDocumentSchema.safeParse(migrated)
  expect(parsed.success).toBe(true)
  const execution = executionFromDocument(migrated)
  expect(execution.state).toBe('running')
  expect(execution.step).toBe('reading')
  expect(execution.inputSnapshot.assets[0]).toEqual({
    assetId: 'card-audio',
    sourceId: 'audio-source',
    name: '下压音',
    relativePath: 'assets/bgm/duck.ogg',
    description: '下压音效',
    usage: { targetIds: [] },
    category: 'audio'
  })
  expect(execution.inputSnapshot.assets[0]).not.toHaveProperty('purpose')
  expect(execution.inputSnapshot.prompts[0]?.references[0]).toEqual({
    cardId: 'card-audio',
    kind: 'audio',
    displayName: '下压音'
  })
  expect(execution.inputSnapshot.prompts[0]?.references[0]).not.toHaveProperty('role')
})

it('共享分类 helper 只读已有时间事实，不推断缺失字段', () => {
  expect(LEGACY_EXECUTION_RECORD_REASONS).toEqual([
    'missing-record-time',
    'current-schema-incomplete',
    'unsupported-envelope-version',
    'unreadable-record'
  ])
  expect(isSupportedExecutionEnvelopeVersion(1)).toBe(true)
  expect(isSupportedExecutionEnvelopeVersion(7)).toBe(true)
  expect(isSupportedExecutionEnvelopeVersion(6.5)).toBe(false)
  expect(isSupportedExecutionEnvelopeVersion(8)).toBe(false)
  expect(isSupportedExecutionEnvelopeVersion('7')).toBe(false)
  expect(legacyExecutionRecordTimeFacts({})).toEqual({
    hasCreatedAt: false,
    hasUpdatedAt: false,
    hasTimeline: false
  })
  expect(legacyExecutionRecordReason({})).toBe('missing-record-time')
  expect(legacyExecutionRecordReason({ createdAt: '2026-01-01T00:00:00.000Z' })).toBe(
    'current-schema-incomplete'
  )
  expect(
    legacyExecutionRecordReason({
      timeline: [{ createdAt: '2026-01-01T00:00:00.000Z' }]
    })
  ).toBe('current-schema-incomplete')
})

function currentExecution(): SceneGenerationExecution {
  return {
    projectId: 'project-1',
    sceneId: 'scene-1',
    operationId: 'operation-new',
    threadId: 'thread-new',
    branchId: 'branch-new',
    fingerprint: 'fingerprint-new',
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

function legacyManifestRecord(
  raw: Record<string, unknown>,
  reason: string
): Record<string, unknown> {
  return {
    projectId: 'project-1',
    sceneId: 'scene-1',
    operationId: raw.operationId,
    threadId: raw.threadId,
    branchId: raw.branchId,
    fingerprint: raw.fingerprint,
    state: raw.state,
    hasCreatedAt: typeof raw.createdAt === 'string',
    hasUpdatedAt: typeof raw.updatedAt === 'string',
    hasTimeline: Array.isArray(raw.timeline) && raw.timeline.length > 0,
    rawSha256: createHash('sha256').update(JSON.stringify(raw)).digest('hex'),
    reason
  }
}

async function writeDocument(
  stateRoot: string,
  value: unknown,
  projectId = 'project-1'
): Promise<string> {
  return writeDocumentBytes(stateRoot, Buffer.from(JSON.stringify(value)), projectId)
}

async function writeDocumentBytes(
  stateRoot: string,
  bytes: Buffer,
  projectId = 'project-1'
): Promise<string> {
  const directory = join(stateRoot, 'scene-generation/projects', projectId)
  const path = join(directory, 'executions.json')
  await mkdir(directory, { recursive: true })
  await writeFile(path, bytes)
  return path
}
