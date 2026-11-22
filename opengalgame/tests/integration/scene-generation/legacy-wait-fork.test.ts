import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { SceneGenerationExecution } from '@application/scene-generation/models/SceneGenerationExecution'
import { executionFromDocument } from '@infrastructure/scene-generation/execution/SceneGenerationExecutionDocument'
import {
  generationInputDigest,
  webGalGenerationCompatibility
} from '@infrastructure/scene-generation/history/WebGalGenerationCheckpoint'
import { LEGACY_CHECKPOINT_COMPATIBILITY } from '@infrastructure/workflow/checkpoints/checkpointCompatibility'
import { ReadOnlyGenerationCheckpointStore } from '@infrastructure/workflow/checkpoints/ReadOnlyCheckpointStore'
import { writeDurableEffect } from '@infrastructure/workflow/execution/durableEffect'
import {
  generationFixture,
  request,
  validScript,
  type GenerationFixture
} from '../../../../harness/acceptance/support/generationFixture'

function digest(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function scopeOf(execution: SceneGenerationExecution): {
  projectId: string
  sceneId: string
  operationId: string
  threadId: string
  branchId: string
  checkpointId: string
} {
  return {
    projectId: execution.projectId,
    sceneId: execution.sceneId,
    operationId: execution.operationId,
    threadId: execution.threadId,
    branchId: execution.branchId,
    checkpointId: execution.checkpointId!
  }
}

interface LegacyBoundary {
  readonly checkpointId: string
  readonly checkpointPath: string
  readonly record: SceneGenerationExecution
  readonly checkpointExecution: SceneGenerationExecution
}

async function executionDocumentPath(f: GenerationFixture): Promise<string> {
  return join(
    f.config.userStateRoot,
    'scene-generation',
    'projects',
    request.projectId,
    'executions.json'
  )
}

async function officialEntry(f: GenerationFixture): Promise<string> {
  return readFile(join(f.projectRoot, 'game/scene/start.txt'), 'utf8')
}

/**
 * 把真实 Pi 等待工程改写成旧版 LangGraph 等待检查点：保留真实候选修订、
 * 工作区和写账本，只补旧图当时会持久化的状态通道。
 */
async function legacyWaitingBoundary(f: GenerationFixture): Promise<LegacyBoundary> {
  const execution = (await f.app.ports.executions.readExecution(request))!
  expect(execution.state).toBe('waiting')
  expect(execution.interaction?.kind).toBe('review')
  expect(execution.candidateSnapshotId).toBeDefined()
  const candidateSnapshotId = execution.candidateSnapshotId!
  const candidate = await f.app.ports.artifacts.readCandidate(execution, candidateSnapshotId)
  const checkpointId = randomUUID()
  const record = await f.app.ports.executions.writeExecution({
    ...execution,
    checkpointId,
    interaction: { ...execution.interaction!, checkpointId }
  })
  const checkpointExecution = executionFromDocument({
    ...record,
    state: 'running',
    step: undefined,
    checkpointId: undefined,
    interaction: undefined,
    pendingReply: undefined,
    updatedAt: record.createdAt
  })
  const stateRoot = join(f.config.userStateRoot, 'ai')
  const store = new ReadOnlyGenerationCheckpointStore(stateRoot)
  const channelValues = {
    execution: checkpointExecution,
    compatibility: webGalGenerationCompatibility(),
    summary: '旧版候选待审阅',
    unresolvedIssues: [],
    status: 'waiting',
    outcome: { kind: 'candidate', candidateSnapshotId },
    candidate: { candidateSnapshotId, preview: candidate.preview },
    'branch:to:waitForHuman': 'validateCandidate'
  }
  const checkpoint = {
    v: 4,
    id: checkpointId,
    ts: record.updatedAt!,
    channel_values: channelValues,
    channel_versions: Object.fromEntries(
      Object.keys(channelValues).map((channel) => [channel, 1])
    ),
    versions_seen: {}
  }
  const [checkpointType, checkpointBytes] = await store.serde.dumpsTyped(checkpoint)
  const [metadataType, metadataBytes] = await store.serde.dumpsTyped({
    source: 'loop',
    step: 0,
    parents: {}
  })
  const directory = join(
    stateRoot,
    'projects',
    record.projectId,
    'threads',
    record.threadId,
    'branches',
    record.branchId,
    'checkpoints',
    '_'
  )
  await mkdir(directory, { recursive: true })
  const checkpointPath = join(directory, `${checkpointId}.json`)
  await writeFile(
    checkpointPath,
    JSON.stringify({
      ...LEGACY_CHECKPOINT_COMPATIBILITY,
      checkpointVersion: checkpoint.v,
      checkpointNs: '',
      checkpointId,
      checkpointSerde: {
        type: checkpointType,
        payload: Buffer.from(checkpointBytes).toString('base64')
      },
      metadataSerde: {
        type: metadataType,
        payload: Buffer.from(metadataBytes).toString('base64')
      },
      inputDigest: generationInputDigest(checkpointExecution),
      operationId: record.operationId,
      candidateRevision: candidateSnapshotId,
      revisionRef: `refs/opengalgame/revisions/${candidateSnapshotId}`
    }),
    'utf8'
  )
  return { checkpointId, checkpointPath, record, checkpointExecution }
}

async function writeLegacyCheckpoint(
  f: GenerationFixture,
  execution: SceneGenerationExecution,
  checkpointId: string,
  channelValues: Record<string, unknown>
): Promise<string> {
  const stateRoot = join(f.config.userStateRoot, 'ai')
  const store = new ReadOnlyGenerationCheckpointStore(stateRoot)
  const stored = executionFromDocument(execution)
  const checkpoint = {
    v: 4,
    id: checkpointId,
    ts: stored.updatedAt!,
    channel_values: {
      ...channelValues,
      execution: stored
    },
    channel_versions: Object.fromEntries(
      Object.keys({ ...channelValues, execution: stored }).map((channel) => [channel, 1])
    ),
    versions_seen: {}
  }
  const [checkpointType, checkpointBytes] = await store.serde.dumpsTyped(checkpoint)
  const [metadataType, metadataBytes] = await store.serde.dumpsTyped({
    source: 'loop',
    step: 0,
    parents: {}
  })
  const directory = join(
    stateRoot,
    'projects',
    stored.projectId,
    'threads',
    stored.threadId,
    'branches',
    stored.branchId,
    'checkpoints',
    '_'
  )
  await mkdir(directory, { recursive: true })
  const checkpointPath = join(directory, `${checkpointId}.json`)
  await writeFile(
    checkpointPath,
    JSON.stringify({
      ...LEGACY_CHECKPOINT_COMPATIBILITY,
      checkpointVersion: checkpoint.v,
      checkpointNs: '',
      checkpointId,
      checkpointSerde: {
        type: checkpointType,
        payload: Buffer.from(checkpointBytes).toString('base64')
      },
      metadataSerde: {
        type: metadataType,
        payload: Buffer.from(metadataBytes).toString('base64')
      },
      inputDigest: generationInputDigest(stored),
      operationId: stored.operationId,
      ...(stored.candidateSnapshotId
        ? {
            candidateRevision: stored.candidateSnapshotId,
            revisionRef: `refs/opengalgame/revisions/${stored.candidateSnapshotId}`
          }
        : {})
    }),
    'utf8'
  )
  return checkpointPath
}

async function generatedWaitingFixture(): Promise<GenerationFixture> {
  const f = await generationFixture({ scriptForWrite: () => validScript })
  await f.app.generation.generateScene({ ...request, reviewCandidate: true })
  await f.run()
  return f
}

it('真实旧等待检查点有可复制候选时，详情可分叉且分叉只执行一次', async () => {
  const f = await generatedWaitingFixture()
  const boundary = await legacyWaitingBoundary(f)
  const scope = scopeOf(boundary.record)
  const source = (await f.app.ports.executions.readExecution(request))!
  const sourceCandidateId = source.candidateSnapshotId!
  const checkpointBefore = digest(await readFile(boundary.checkpointPath))
  const officialBefore = await officialEntry(f)
  const modelCallsBefore = f.bodies.length
  const sourceCandidate = await f.app.ports.artifacts.readCandidate(source, sourceCandidateId)
  const forkBase = {
    projectId: request.projectId,
    sceneId: request.sceneId,
    threadId: source.threadId,
    branchId: source.branchId
  }

  const detail = await f.app.history.readSceneGenerationHistoryDetail({
    ...scope,
    checkpointId: boundary.checkpointId
  })
  expect(detail.canFork).toBe(true)
  expect(detail.forkReason).toBeUndefined()

  const result = await f.app.generation.forkSceneGeneration({
    ...forkBase,
    operationId: 'fork-legacy',
    checkpointId: boundary.checkpointId,
    policy: request.policy,
    reviewCandidate: true
  })
  expect(f.jobs).toHaveLength(1)
  await f.run()
  expect(f.bodies).toHaveLength(modelCallsBefore)

  const forked = (await f.app.ports.executions.readExecution({
    projectId: request.projectId,
    sceneId: request.sceneId,
    operationId: 'fork-legacy'
  }))!
  expect(forked.branchId).not.toBe(source.branchId)
  expect(forked.threadId).toBe(source.threadId)
  expect(forked.fork).toMatchObject({
    projectId: source.projectId,
    sceneId: source.sceneId,
    threadId: source.threadId,
    branchId: source.branchId,
    checkpointId: boundary.checkpointId,
    sourceOperationId: source.operationId,
    candidateSnapshotId: sourceCandidateId
  })
  expect(forked.candidateSnapshotId).toBe(sourceCandidateId)
  expect(forked.inputSnapshot).toEqual(source.inputSnapshot)
  expect(forked.state).toBe('waiting')
  expect(result.forkFrom.summary).toBe('旧版候选待审阅')

  const forkedCandidate = await f.app.ports.artifacts.readCandidate(forked, sourceCandidateId)
  expect(forkedCandidate.candidateSnapshotId).toBe(sourceCandidate.candidateSnapshotId)
  expect(forkedCandidate.artifact).toEqual(sourceCandidate.artifact)

  // 原记录、原检查点、原候选和正式作品都不因分叉改变。
  expect(await f.app.ports.executions.readExecution(request)).toEqual(source)
  expect(digest(await readFile(boundary.checkpointPath))).toBe(checkpointBefore)
  expect(await f.app.ports.artifacts.readCandidate(source, sourceCandidateId)).toEqual(
    sourceCandidate
  )
  expect(await officialEntry(f)).toBe(officialBefore)
})

it('working 无候选、候选身份不符和未结算写入都不能从旧历史创建任务', async () => {
  const f = await generatedWaitingFixture()
  const boundary = await legacyWaitingBoundary(f)
  const scope = scopeOf(boundary.record)
  const executionsBefore = await readFile(await executionDocumentPath(f))
  const officialBefore = await officialEntry(f)
  const modelCallsBefore = f.bodies.length
  const operationsBefore = await f.app.ports.executions.listSceneExecutions({
    projectId: request.projectId,
    sceneId: request.sceneId,
    limit: 100
  })

  const workingCheckpointId = randomUUID()
  const workingExecution = executionFromDocument({
    ...boundary.checkpointExecution,
    candidateSnapshotId: undefined,
    state: 'running'
  })
  await writeLegacyCheckpoint(f, workingExecution, workingCheckpointId, {
    compatibility: webGalGenerationCompatibility(),
    summary: '旧版仍在生成',
    unresolvedIssues: [],
    status: 'working'
  })
  const workingDetail = await f.app.history.readSceneGenerationHistoryDetail({
    ...scope,
    checkpointId: workingCheckpointId
  })
  expect(workingDetail.canFork).toBe(false)
  expect(workingDetail.forkReason).toBe('没有可复制的候选修订，不能分叉')

  const mismatchCheckpointId = randomUUID()
  const sourceCandidateId = boundary.record.candidateSnapshotId!
  const wrongCandidateId = 'f'.repeat(40)
  await writeLegacyCheckpoint(f, boundary.checkpointExecution, mismatchCheckpointId, {
    execution: boundary.checkpointExecution,
    compatibility: webGalGenerationCompatibility(),
    summary: '候选身份不符',
    unresolvedIssues: [],
    status: 'waiting',
    outcome: { kind: 'candidate', candidateSnapshotId: wrongCandidateId },
    candidate: { candidateSnapshotId: wrongCandidateId },
    'branch:to:waitForHuman': 'validateCandidate'
  })
  const mismatchDetail = await f.app.history.readSceneGenerationHistoryDetail({
    ...scope,
    checkpointId: mismatchCheckpointId
  })
  expect(mismatchDetail.canFork).toBe(false)
  expect(mismatchDetail.forkReason).toBe('检查点保存的候选与执行快照不一致，不能分叉')

  await writeDurableEffect(join(f.config.userStateRoot, 'ai'), boundary.record, {
    operationId: boundary.record.operationId,
    stepId: 'legacy-unsettled',
    inputDigest: 'unsettled-input',
    status: 'started',
    kind: 'fileWrite'
  })
  const unsettledDetail = await f.app.history.readSceneGenerationHistoryDetail({
    ...scope,
    checkpointId: boundary.checkpointId
  })
  expect(unsettledDetail.canFork).toBe(false)

  for (const [operationId, checkpointId] of [
    ['fork-working', workingCheckpointId],
    ['fork-mismatch', mismatchCheckpointId],
    ['fork-unsettled', boundary.checkpointId]
  ] as const) {
    await expect(
      f.app.generation.forkSceneGeneration({
        projectId: request.projectId,
        sceneId: request.sceneId,
        threadId: boundary.record.threadId,
        branchId: boundary.record.branchId,
        operationId,
        checkpointId,
        policy: request.policy,
        reviewCandidate: true
      })
    ).rejects.toMatchObject({ code: 4103 })
  }
  expect(f.jobs).toHaveLength(0)
  expect(f.bodies).toHaveLength(modelCallsBefore)
  expect(await officialEntry(f)).toBe(officialBefore)
  expect(await readFile(await executionDocumentPath(f))).toEqual(executionsBefore)
  expect(
    await f.app.ports.executions.listSceneExecutions({
      projectId: request.projectId,
      sceneId: request.sceneId,
      limit: 100
    })
  ).toEqual(operationsBefore)
  expect(sourceCandidateId).toBe(boundary.record.candidateSnapshotId)
})

it('详情读取后来源不再停在等待边界时拒绝分叉，不产生新任务', async () => {
  const f = await generatedWaitingFixture()
  const boundary = await legacyWaitingBoundary(f)
  const scope = scopeOf(boundary.record)
  const detail = await f.app.history.readSceneGenerationHistoryDetail({
    ...scope,
    checkpointId: boundary.checkpointId
  })
  expect(detail.canFork).toBe(true)

  await f.app.ports.executions.writeExecution({
    ...boundary.record,
    state: 'running',
    step: 'generating'
  })
  const executionsBefore = await readFile(await executionDocumentPath(f))
  const modelCallsBefore = f.bodies.length

  await expect(
    f.app.generation.forkSceneGeneration({
      projectId: request.projectId,
      sceneId: request.sceneId,
      threadId: boundary.record.threadId,
      branchId: boundary.record.branchId,
      operationId: 'fork-race',
      checkpointId: boundary.checkpointId,
      policy: request.policy,
      reviewCandidate: true
    })
  ).rejects.toMatchObject({ code: 4103 })
  expect(f.jobs).toHaveLength(0)
  expect(f.bodies).toHaveLength(modelCallsBefore)
  expect(await readFile(await executionDocumentPath(f))).toEqual(executionsBefore)
  expect(
    await f.app.ports.executions.readExecution({
      projectId: request.projectId,
      sceneId: request.sceneId,
      operationId: 'fork-race'
    })
  ).toBeNull()
})

it('同一线程已有分叉在排队时不能再从旧等待创建第二个任务', async () => {
  const f = await generatedWaitingFixture()
  const boundary = await legacyWaitingBoundary(f)
  const source = (await f.app.ports.executions.readExecution(request))!

  await f.app.generation.forkSceneGeneration({
    projectId: request.projectId,
    sceneId: request.sceneId,
    threadId: source.threadId,
    branchId: source.branchId,
    operationId: 'fork-first',
    checkpointId: boundary.checkpointId,
    policy: request.policy,
    reviewCandidate: true
  })
  expect(f.jobs).toHaveLength(1)
  await expect(
    f.app.generation.forkSceneGeneration({
      projectId: request.projectId,
      sceneId: request.sceneId,
      threadId: source.threadId,
      branchId: source.branchId,
      operationId: 'fork-second',
      checkpointId: boundary.checkpointId,
      policy: request.policy,
      reviewCandidate: true
    })
  ).rejects.toMatchObject({ code: 4103 })
  expect(f.jobs).toHaveLength(1)

  await f.run()
  expect(
    await f.app.ports.executions.readExecution({
      projectId: request.projectId,
      sceneId: request.sceneId,
      operationId: 'fork-second'
    })
  ).toBeNull()
  expect(await f.app.ports.executions.readExecution(request)).toEqual(source)
})

function forkOperationPath(
  f: GenerationFixture,
  threadId: string,
  operationId: string,
  fileName: string
): string {
  return join(
    f.config.userStateRoot,
    'ai',
    'projects',
    request.projectId,
    'threads',
    threadId,
    'operations',
    operationId,
    fileName
  )
}

async function createLegacyForkWithoutEvidence(
  f: GenerationFixture,
  boundary: LegacyBoundary,
  operationId: string,
  options?: { keepMarker?: boolean }
): Promise<{ source: SceneGenerationExecution; evidencePath: string; markerPath: string }> {
  const source = (await f.app.ports.executions.readExecution(request))!
  await f.app.generation.forkSceneGeneration({
    projectId: request.projectId,
    sceneId: request.sceneId,
    threadId: source.threadId,
    branchId: source.branchId,
    operationId,
    checkpointId: boundary.checkpointId,
    policy: request.policy,
    reviewCandidate: true
  })
  expect(f.jobs).toHaveLength(1)
  const evidencePath = forkOperationPath(f, source.threadId, operationId, 'fork-source.json')
  const markerPath = forkOperationPath(f, source.threadId, operationId, 'fork-source.captured.json')
  const captured = JSON.parse(await readFile(evidencePath, 'utf8')) as {
    checkpointKind?: string
    digest?: string
  }
  expect(captured.checkpointKind).toBe('legacy')
  expect(JSON.parse(await readFile(markerPath, 'utf8'))).toMatchObject({
    version: 1,
    evidenceDigest: captured.digest
  })
  await rm(evidencePath)
  // 删除两者只复现“双缺”现场；本用例不据此把新分叉当成旧记录。
  if (options?.keepMarker !== true) await rm(markerPath)
  return { source, evidencePath, markerPath }
}

it('新建自旧检查点的分叉丢失证据与标记后不补证', async () => {
  const f = await generatedWaitingFixture()
  const boundary = await legacyWaitingBoundary(f)
  const officialBefore = await officialEntry(f)
  const checkpointBefore = digest(await readFile(boundary.checkpointPath))
  const callsBefore = f.bodies.length
  const operationId = 'fork-legacy-double-missing'
  const { source, evidencePath, markerPath } = await createLegacyForkWithoutEvidence(
    f,
    boundary,
    operationId
  )

  const runError = await f.run().catch((error: unknown) => error)
  expect(String(runError)).toContain('待核对')

  const after = (await f.app.ports.executions.readExecution({
    projectId: request.projectId,
    sceneId: request.sceneId,
    operationId
  }))!
  expect(after.state).toBe('interrupted')
  expect(after.interruptReason).toBe('writeUnknown')
  expect(after.failure?.message).toContain('无法证明创建时来源')
  await expect(readFile(evidencePath)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(markerPath)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await f.app.ports.executions.readExecution(request)).toEqual(source)
  expect(digest(await readFile(boundary.checkpointPath))).toBe(checkpointBefore)
  expect(await officialEntry(f)).toBe(officialBefore)
  expect(f.bodies).toHaveLength(callsBefore)
})

it('证据文件被删除但捕获标记仍在时不补证', async () => {
  const f = await generatedWaitingFixture()
  const boundary = await legacyWaitingBoundary(f)
  const officialBefore = await officialEntry(f)
  const callsBefore = f.bodies.length
  const operationId = 'fork-legacy-tampered-evidence'
  const { source, evidencePath, markerPath } = await createLegacyForkWithoutEvidence(
    f,
    boundary,
    operationId,
    { keepMarker: true }
  )
  const markerBefore = await readFile(markerPath)

  const runError = await f.run().catch((error: unknown) => error)
  expect(String(runError)).toContain('待核对')

  const after = (await f.app.ports.executions.readExecution({
    projectId: request.projectId,
    sceneId: request.sceneId,
    operationId
  }))!
  expect(after.state).toBe('interrupted')
  expect(after.interruptReason).toBe('writeUnknown')
  await expect(readFile(evidencePath)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(markerPath)).toEqual(markerBefore)
  expect(await f.app.ports.executions.readExecution(request)).toEqual(source)
  expect(await officialEntry(f)).toBe(officialBefore)
  expect(f.bodies).toHaveLength(callsBefore)
})

it('旧记录从未捕获证据的 Pi 分叉仍不补证', async () => {
  const f = await generatedWaitingFixture()
  const source = (await f.app.ports.executions.readExecution(request))!
  const officialBefore = await officialEntry(f)
  const callsBefore = f.bodies.length
  const operationId = 'fork-pi-no-evidence-era'
  await f.app.generation.forkSceneGeneration({
    projectId: request.projectId,
    sceneId: request.sceneId,
    threadId: source.threadId,
    branchId: source.branchId,
    operationId,
    checkpointId: source.checkpointId!,
    policy: request.policy,
    reviewCandidate: true
  })
  expect(f.jobs).toHaveLength(1)
  const evidencePath = forkOperationPath(f, source.threadId, operationId, 'fork-source.json')
  const markerPath = forkOperationPath(f, source.threadId, operationId, 'fork-source.captured.json')
  await rm(evidencePath)
  await rm(markerPath)

  const runError = await f.run().catch((error: unknown) => error)
  expect(String(runError)).toContain('待核对')

  const after = (await f.app.ports.executions.readExecution({
    projectId: request.projectId,
    sceneId: request.sceneId,
    operationId
  }))!
  expect(after.state).toBe('interrupted')
  expect(after.interruptReason).toBe('writeUnknown')
  await expect(readFile(evidencePath)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(markerPath)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await f.app.ports.executions.readExecution(request)).toEqual(source)
  expect(await officialEntry(f)).toBe(officialBefore)
  expect(f.bodies).toHaveLength(callsBefore)
})

it('旧检查点仍可读且来源已推进时，双缺证据仍不补证', async () => {
  const f = await generatedWaitingFixture()
  const boundary = await legacyWaitingBoundary(f)
  const officialBefore = await officialEntry(f)
  const operationId = 'fork-legacy-advance'
  const { source, evidencePath, markerPath } = await createLegacyForkWithoutEvidence(
    f,
    boundary,
    operationId
  )
  const checkpointScope = {
    projectId: request.projectId,
    sceneId: request.sceneId,
    threadId: source.threadId,
    branchId: source.branchId,
    checkpointId: boundary.checkpointId
  }
  expect((await f.app.history.readSceneGenerationHistoryDetail(checkpointScope)).canFork).toBe(
    true
  )
  const advanced = await f.app.ports.executions.writeExecution({
    ...source,
    checkpointId: 'pi-review-operation-test-advanced',
    candidateSnapshotId: 'f'.repeat(40)
  })
  expect((await f.app.history.readSceneGenerationHistoryDetail(checkpointScope)).canFork).toBe(
    false
  )

  const runError = await f.run().catch((error: unknown) => error)
  expect(String(runError)).toContain('待核对')

  const after = (await f.app.ports.executions.readExecution({
    projectId: request.projectId,
    sceneId: request.sceneId,
    operationId
  }))!
  expect(after.state).toBe('interrupted')
  expect(after.interruptReason).toBe('writeUnknown')
  await expect(readFile(evidencePath)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(markerPath)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await f.app.ports.executions.readExecution(request)).toEqual(advanced)
  expect(await officialEntry(f)).toBe(officialBefore)
})

it('旧格式检查点证据损坏时不覆盖现场', async () => {
  const f = await generatedWaitingFixture()
  const boundary = await legacyWaitingBoundary(f)
  const officialBefore = await officialEntry(f)
  const { source, evidencePath } = await createLegacyForkWithoutEvidence(
    f,
    boundary,
    'fork-legacy-corrupt-evidence'
  )
  const corrupt = Buffer.from('{not-json', 'utf8')
  await writeFile(evidencePath, corrupt)

  const runError = await f.run().catch((error: unknown) => error)
  expect(String(runError)).toContain('待核对')

  const after = (await f.app.ports.executions.readExecution({
    projectId: request.projectId,
    sceneId: request.sceneId,
    operationId: 'fork-legacy-corrupt-evidence'
  }))!
  expect(after.state).toBe('interrupted')
  expect(after.interruptReason).toBe('writeUnknown')
  expect(after.failure?.message).toContain('待核对')
  expect(await readFile(evidencePath)).toEqual(corrupt)
  expect(await f.app.ports.executions.readExecution(request)).toEqual(source)
  expect(await officialEntry(f)).toBe(officialBefore)
})
