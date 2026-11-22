import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { SceneGenerationExecution } from '@application/scene-generation/models/SceneGenerationExecution'
import { AiProjectFileSystemImpl } from '@infrastructure/ai/filesystem/AiProjectFileSystemImpl'
import { executionFromDocument } from '@infrastructure/scene-generation/execution/SceneGenerationExecutionDocument'
import { FileSceneGenerationExecutionRepositoryImpl } from '@infrastructure/scene-generation/execution/FileSceneGenerationExecutionRepositoryImpl'
import {
  generationInputDigest,
  webGalGenerationCompatibility
} from '@infrastructure/scene-generation/history/WebGalGenerationCheckpoint'
import { WebGalSceneGenerationHistoryReaderImpl } from '@infrastructure/scene-generation/history/WebGalSceneGenerationHistoryReaderImpl'
import { LEGACY_CHECKPOINT_COMPATIBILITY } from '@infrastructure/workflow/checkpoints/checkpointCompatibility'
import { ReadOnlyGenerationCheckpointStore } from '@infrastructure/workflow/checkpoints/ReadOnlyCheckpointStore'
import { writeDurableEffect } from '@infrastructure/workflow/execution/durableEffect'
import {
  generationFixture,
  request,
  validScript,
  type GenerationFixture
} from '../../../../harness/acceptance/support/generationFixture'
import { createSceneGeneration } from '../../../../harness/acceptance/support/sceneGenerationEntry'

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex')
}

function legacyReader(f: GenerationFixture): {
  readonly reader: WebGalSceneGenerationHistoryReaderImpl
  readonly files: AiProjectFileSystemImpl
} {
  const stateRoot = join(f.config.userStateRoot, 'ai')
  const files = new AiProjectFileSystemImpl(f.config.userStateRoot)
  return {
    reader: new WebGalSceneGenerationHistoryReaderImpl(
      stateRoot,
      new ReadOnlyGenerationCheckpointStore(stateRoot),
      files,
      new FileSceneGenerationExecutionRepositoryImpl(f.config.userStateRoot)
    ),
    files
  }
}

interface LegacyBoundary {
  readonly checkpointId: string
  readonly checkpointPath: string
  readonly record: SceneGenerationExecution
  readonly checkpointExecution: SceneGenerationExecution
}

/** 把真实 Pi 等待工程改写成旧版 LangGraph 检查点边界，保留真实候选、工作区和写账本。 */
async function legacyWaitingBoundary(f: GenerationFixture): Promise<LegacyBoundary> {
  const execution = (await f.app.ports.executions.readExecution(request))!
  expect(execution.state).toBe('waiting')
  expect(execution.interaction?.kind).toBe('review')
  expect(execution.candidateSnapshotId).toBeDefined()
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
  const checkpoint = {
    v: 4,
    id: checkpointId,
    ts: record.updatedAt!,
    channel_values: {
      execution: checkpointExecution,
      compatibility: webGalGenerationCompatibility(),
      summary: '旧版候选待审阅',
      unresolvedIssues: []
    },
    channel_versions: {
      execution: 1,
      compatibility: 1,
      summary: 1,
      unresolvedIssues: 1
    },
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
      candidateRevision: checkpointExecution.candidateSnapshotId,
      revisionRef: `refs/opengalgame/revisions/${checkpointExecution.candidateSnapshotId}`
    }),
    'utf8'
  )
  return { checkpointId, checkpointPath, record, checkpointExecution }
}

function scopeOf(boundary: LegacyBoundary): {
  projectId: string
  sceneId: string
  operationId: string
  threadId: string
  branchId: string
  checkpointId: string
} {
  return {
    projectId: boundary.record.projectId,
    sceneId: boundary.record.sceneId,
    operationId: boundary.record.operationId,
    threadId: boundary.record.threadId,
    branchId: boundary.record.branchId,
    checkpointId: boundary.checkpointId
  }
}

function replyOf(
  boundary: LegacyBoundary,
  replyId = 'legacy-reply-1'
): {
  projectId: string
  sceneId: string
  operationId: string
  threadId: string
  branchId: string
  interactionId: string
  checkpointId: string
  candidateSnapshotId: string
  replyId: string
  reply: { kind: 'accept' }
} {
  return {
    projectId: boundary.record.projectId,
    sceneId: boundary.record.sceneId,
    operationId: boundary.record.operationId,
    threadId: boundary.record.threadId,
    branchId: boundary.record.branchId,
    interactionId: boundary.record.interaction!.interactionId,
    checkpointId: boundary.checkpointId,
    candidateSnapshotId: boundary.record.candidateSnapshotId!,
    replyId,
    reply: { kind: 'accept' }
  }
}

async function executionRecordPath(f: GenerationFixture): Promise<string> {
  return join(
    f.config.userStateRoot,
    'scene-generation',
    'projects',
    request.projectId,
    'executions.json'
  )
}

it('旧版等待审阅可重开并接受一次；不改检查点，重复接受不重复提交', async () => {
  const f = await generationFixture({ scriptForWrite: () => validScript })
  await f.app.generation.generateScene({ ...request, reviewCandidate: true })
  await f.run()
  const boundary = await legacyWaitingBoundary(f)
  const scope = scopeOf(boundary)
  const { reader, files } = legacyReader(f)
  const recordPath = await executionRecordPath(f)
  const recordBefore = digest(await readFile(recordPath))
  const checkpointBefore = digest(await readFile(boundary.checkpointPath))

  const detail = await reader.readCheckpoint(scope)
  expect(detail.view).toMatchObject({
    checkpointId: boundary.checkpointId,
    phase: 'waiting',
    canContinue: true,
    canReply: true
  })
  const history = await reader.listHistory({
    projectId: scope.projectId,
    sceneId: scope.sceneId,
    threadId: scope.threadId,
    branchId: scope.branchId,
    limit: 20
  })
  expect(history.checkpoints).toContainEqual(
    expect.objectContaining({
      checkpointId: boundary.checkpointId,
      canReply: true
    })
  )
  expect(digest(await readFile(recordPath))).toBe(recordBefore)
  expect(digest(await readFile(boundary.checkpointPath))).toBe(checkpointBefore)

  const officialPath = join(f.projectRoot, 'game/scene/start.txt')
  const officialBefore = digest(await readFile(officialPath))
  const workspace = files.locateWorkspace(boundary.record)
  const candidate = await readFile(join(workspace.rootDirectory, 'game/scene/start.txt'), 'utf8')
  const commitsBefore = f.git('rev-list', '--count', 'HEAD')

  await f.app.generation.replySceneGenerationInteraction(replyOf(boundary))
  expect((await f.app.ports.executions.readExecution(request))?.state).toBe('pending')
  expect(f.jobs).toHaveLength(1)
  await f.run()
  const status = await f.app.status.getSceneGenerationStatus(request)
  expect(status.state).toBe('succeeded')
  expect(status.result?.commitId).toBeTruthy()
  expect(await readFile(officialPath, 'utf8')).toBe(candidate)
  expect(digest(await readFile(officialPath))).not.toBe(officialBefore)
  expect(f.git('rev-list', '--count', 'HEAD')).toBe(String(Number(commitsBefore) + 1))
  expect(digest(await readFile(boundary.checkpointPath))).toBe(checkpointBefore)

  const committed = digest(await readFile(officialPath))
  await f.app.generation.replySceneGenerationInteraction(replyOf(boundary))
  expect(f.jobs).toHaveLength(0)
  expect(digest(await readFile(officialPath))).toBe(committed)
  expect(f.git('rev-list', '--count', 'HEAD')).toBe(String(Number(commitsBefore) + 1))
})

it('旧版等待的已持久接受在重启后按回复资格重放，不重复提交', async () => {
  const f = await generationFixture({ scriptForWrite: () => validScript })
  await f.app.generation.generateScene({ ...request, reviewCandidate: true })
  await f.run()
  const boundary = await legacyWaitingBoundary(f)
  const scope = scopeOf(boundary)
  const { reader } = legacyReader(f)
  const commitsBefore = f.git('rev-list', '--count', 'HEAD')
  const modelRequests = f.bodies.length

  await f.app.generation.replySceneGenerationInteraction(replyOf(boundary))
  expect(f.jobs).toHaveLength(1)
  expect((await reader.readCheckpoint(scope)).view.canReply).toBe(true)
  // 模拟进程在任务执行前退出：旧任务不会被新进程消费。
  f.jobs.length = 0
  const restarted = await createSceneGeneration(f.config)
  await restarted.generation.resumeSceneGeneration(request)
  expect(f.jobs).toHaveLength(1)
  await f.run()
  const status = await restarted.status.getSceneGenerationStatus(request)
  expect(status.state).toBe('succeeded')
  expect(f.bodies).toHaveLength(modelRequests)
  expect(f.git('rev-list', '--count', 'HEAD')).toBe(String(Number(commitsBefore) + 1))
  await restarted.generation.replySceneGenerationInteraction(replyOf(boundary))
  expect(f.jobs).toHaveLength(0)
  expect(f.git('rev-list', '--count', 'HEAD')).toBe(String(Number(commitsBefore) + 1))
})

it('输入摘要不匹配时检查点仍可续跑但不能回复，重启也不把 canContinue 当 canReply', async () => {
  const f = await generationFixture({ scriptForWrite: () => validScript })
  await f.app.generation.generateScene({ ...request, reviewCandidate: true })
  await f.run()
  const boundary = await legacyWaitingBoundary(f)
  const scope = scopeOf(boundary)
  const { reader } = legacyReader(f)
  const changed = {
    ...boundary.record,
    inputSnapshot: { ...boundary.record.inputSnapshot, canvasId: 'canvas-changed' }
  }
  await f.app.ports.executions.writeExecution(changed)
  const checkpointBefore = digest(await readFile(boundary.checkpointPath))
  const officialBefore = digest(await readFile(join(f.projectRoot, 'game/scene/start.txt')))

  const detail = await reader.readCheckpoint(scope)
  expect(detail.view.canContinue).toBe(true)
  expect(detail.view.canReply).toBe(false)
  await expect(f.app.generation.replySceneGenerationInteraction(replyOf(boundary))).rejects.toMatchObject({ code: 4103 })
  expect(f.jobs).toHaveLength(0)
  expect((await f.app.ports.executions.readExecution(request))?.state).toBe('waiting')
  expect(digest(await readFile(join(f.projectRoot, 'game/scene/start.txt')))).toBe(officialBefore)
  expect(digest(await readFile(boundary.checkpointPath))).toBe(checkpointBefore)

  const pending = replyOf(boundary)
  const replay = {
    ...changed,
    interaction: undefined,
    state: 'pending' as const,
    pendingReply: pending,
    replies: [pending]
  }
  await f.app.ports.executions.writeExecution(replay)
  const restarted = await createSceneGeneration(f.config)
  await expect(restarted.generation.resumeSceneGeneration(request)).rejects.toMatchObject({
    code: 4103
  })
  expect(f.jobs).toHaveLength(0)
})

it('审阅授权扩大、工作区改动和写账本结果不明都拒绝回复', async () => {
  const authorization = await generationFixture({ scriptForWrite: () => validScript })
  await authorization.app.generation.generateScene({ ...request, reviewCandidate: true })
  await authorization.run()
  const authorizationBoundary = await legacyWaitingBoundary(authorization)
  await authorization.app.ports.executions.writeExecution({
    ...authorizationBoundary.record,
    interaction: {
      ...authorizationBoundary.record.interaction!,
      allowedReplies: ['accept', 'revise', 'discard', 'answers']
    }
  })
  const authorizationReader = legacyReader(authorization).reader
  expect(
    (await authorizationReader.readCheckpoint(scopeOf(authorizationBoundary))).view.canReply
  ).toBe(false)
  await expect(
    authorization.app.generation.replySceneGenerationInteraction(
      replyOf(authorizationBoundary)
    )
  ).rejects.toMatchObject({ code: 4103 })
  expect(authorization.jobs).toHaveLength(0)

  const workspace = await generationFixture({ scriptForWrite: () => validScript })
  await workspace.app.generation.generateScene({ ...request, reviewCandidate: true })
  await workspace.run()
  const workspaceBoundary = await legacyWaitingBoundary(workspace)
  const workspaceFiles = legacyReader(workspace).files
  const candidateWorkspace = workspaceFiles.locateWorkspace(workspaceBoundary.record)
  await workspaceFiles.writeFile(
    candidateWorkspace,
    'game/scene/start.txt',
    Buffer.from('say:被改动;')
  )
  expect(
    (await legacyReader(workspace).reader.readCheckpoint(scopeOf(workspaceBoundary))).view.canReply
  ).toBe(false)
  await expect(
    workspace.app.generation.replySceneGenerationInteraction(replyOf(workspaceBoundary))
  ).rejects.toMatchObject({ code: 4103 })
  expect(workspace.jobs).toHaveLength(0)

  const ledger = await generationFixture({ scriptForWrite: () => validScript })
  await ledger.app.generation.generateScene({ ...request, reviewCandidate: true })
  await ledger.run()
  const ledgerBoundary = await legacyWaitingBoundary(ledger)
  await writeDurableEffect(join(ledger.config.userStateRoot, 'ai'), ledgerBoundary.record, {
    operationId: ledgerBoundary.record.operationId,
    stepId: 'repair-0-unknown',
    inputDigest: 'unknown-input',
    status: 'started',
    kind: 'fileWrite',
    questions: []
  })
  const ledgerDetail = await legacyReader(ledger).reader.readCheckpoint(scopeOf(ledgerBoundary))
  expect(ledgerDetail.view.canReply).toBe(false)
  expect(ledgerDetail.view.canContinue).toBe(false)
  await expect(
    ledger.app.generation.replySceneGenerationInteraction(replyOf(ledgerBoundary))
  ).rejects.toMatchObject({ code: 4103 })
  expect(ledger.jobs).toHaveLength(0)
})

it('检查点标识或审阅授权身份不匹配时拒绝', async () => {
  const f = await generationFixture({ scriptForWrite: () => validScript })
  await f.app.generation.generateScene({ ...request, reviewCandidate: true })
  await f.run()
  const boundary = await legacyWaitingBoundary(f)
  await f.app.ports.executions.writeExecution({
    ...boundary.record,
    interaction: {
      ...boundary.record.interaction!,
      checkpointId: randomUUID()
    }
  })
  expect(
    (await legacyReader(f).reader.readCheckpoint(scopeOf(boundary))).view.canReply
  ).toBe(false)
  await expect(
    f.app.generation.replySceneGenerationInteraction(replyOf(boundary))
  ).rejects.toMatchObject({ code: 4103 })
  expect(f.jobs).toHaveLength(0)
})
