import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { AiProjectFileSystemImpl } from '@infrastructure/ai/filesystem/AiProjectFileSystemImpl'
import { FileSceneGenerationExecutionRepositoryImpl } from '@infrastructure/scene-generation/execution/FileSceneGenerationExecutionRepositoryImpl'
import { WebGalSceneGenerationHistoryReaderImpl } from '@infrastructure/scene-generation/history/WebGalSceneGenerationHistoryReaderImpl'
import { ReadOnlyGenerationCheckpointStore } from '@infrastructure/workflow/checkpoints/ReadOnlyCheckpointStore'
import { writeDurableEffect } from '@infrastructure/workflow/execution/durableEffect'
import {
  generationFixture,
  request,
  validScript
} from '../../../../harness/acceptance/support/generationFixture'

const forkScript = 'changeBg:station.svg;\n林:分叉后的台词 -clear;\nend;'
const platformSvg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#705030"/></svg>'

/** 用真实持久层重新打开执行记录与历史读取，不用原实例的内存缓存。 */
function reopen(userStateRoot: string): {
  readonly executions: FileSceneGenerationExecutionRepositoryImpl
  readonly history: WebGalSceneGenerationHistoryReaderImpl
} {
  const stateRoot = join(userStateRoot, 'ai')
  const files = new AiProjectFileSystemImpl(userStateRoot)
  const executions = new FileSceneGenerationExecutionRepositoryImpl(userStateRoot)
  return {
    executions,
    history: new WebGalSceneGenerationHistoryReaderImpl(
      stateRoot,
      new ReadOnlyGenerationCheckpointStore(stateRoot),
      files,
      executions
    )
  }
}

it('Pi 审阅边界进入历史；分叉复制草稿/输入/修订，不调模型且不动来源', async () => {
  const f = await generationFixture({
    scriptForWrite: (writes) => (writes === 1 ? validScript : forkScript)
  })
  const operation = await f.app.generation.generateScene({ ...request, reviewCandidate: true })
  await f.run()
  const source = (await f.app.ports.executions.readExecution(request))!
  expect(source.state).toBe('waiting')
  expect(source.candidateSnapshotId).toBeDefined()
  expect(source.checkpointId).toBeDefined()
  const sourceCheckpointId = source.checkpointId!
  const sourceCandidate = source.candidateSnapshotId!
  const sourceWorkspace = new AiProjectFileSystemImpl(f.config.userStateRoot).locateWorkspace(
    source
  )

  // 原工作台分支历史与详情都能读到 Pi 审阅边界，并明确可复制。
  const sourceHistory = await f.app.history.listSceneGenerationHistory({
    ...operation,
    limit: 20
  })
  expect(sourceHistory.checkpoints).toContainEqual(
    expect.objectContaining({
      checkpointId: sourceCheckpointId,
      canView: true,
      canFork: true
    })
  )
  const detail = await f.app.history.readSceneGenerationCheckpoint({
    ...operation,
    checkpointId: sourceCheckpointId
  })
  expect(detail).toMatchObject({
    checkpointId: sourceCheckpointId,
    canContinue: false,
    canFork: true
  })
  const sceneHistory = await f.app.history.listSceneGenerationHistoryForScene({
    projectId: request.projectId,
    sceneId: request.sceneId,
    limit: 20
  })
  expect(sceneHistory.map((item) => item.checkpointId)).toContain(sourceCheckpointId)

  const modelCallsBeforeFork = f.bodies.length
  await f.app.generation.forkSceneGeneration({
    ...operation,
    operationId: 'fork-operation',
    checkpointId: sourceCheckpointId,
    policy: request.policy,
    reviewCandidate: true
  })
  await f.run()
  // 无输入/决定变化时只复制并重新判定，不重放来源模型轮次。
  expect(f.bodies).toHaveLength(modelCallsBeforeFork)

  const forked = (await f.app.ports.executions.readExecution({
    projectId: request.projectId,
    sceneId: request.sceneId,
    operationId: 'fork-operation'
  }))!
  expect(forked.branchId).not.toBe(source.branchId)
  expect(forked.fork).toMatchObject({
    projectId: request.projectId,
    sceneId: request.sceneId,
    threadId: source.threadId,
    branchId: source.branchId,
    checkpointId: sourceCheckpointId,
    candidateSnapshotId: sourceCandidate
  })
  expect(forked.forkRequest).toBeUndefined()
  expect(forked.candidateSnapshotId).toBe(sourceCandidate)
  expect(forked.inputSnapshot).toEqual(source.inputSnapshot)
  expect(forked.state).toBe('waiting')

  const forkedWorkspace = new AiProjectFileSystemImpl(f.config.userStateRoot).locateWorkspace(
    forked
  )
  expect(await readFile(join(forkedWorkspace.rootDirectory, 'game/scene/start.txt'), 'utf8')).toBe(
    validScript
  )
  expect(await readFile(join(sourceWorkspace.rootDirectory, 'game/scene/start.txt'), 'utf8')).toBe(
    validScript
  )
  expect(await readFile(join(f.projectRoot, 'game/scene/start.txt'), 'utf8')).toBe('say:原稿;')
  expect(await f.app.ports.executions.readExecution(request)).toEqual(source)

  const forkHistory = await f.app.history.listSceneGenerationHistory({
    ...forked,
    limit: 20
  })
  expect(forkHistory.checkpoints.map((item) => item.checkpointId)).toContain(forked.checkpointId)
  expect(forkHistory.branches).toContainEqual(
    expect.objectContaining({ branchId: forked.branchId, sourceBranchId: source.branchId })
  )

  // 重开持久层：来源关系、来源分支与分叉边界都还在。
  const opened = reopen(f.config.userStateRoot)
  const reopenedFork = (await opened.executions.readExecution({
    projectId: request.projectId,
    sceneId: request.sceneId,
    operationId: 'fork-operation'
  }))!
  expect(reopenedFork.fork).toEqual(forked.fork)
  const reopenedHistory = await opened.history.listHistory({ ...forked, limit: 20 })
  expect(reopenedHistory.checkpoints.map((item) => item.checkpointId)).toContain(
    forked.checkpointId
  )
  const reopenedSourceHistory = await opened.history.listHistory({ ...operation, limit: 20 })
  expect(reopenedSourceHistory.checkpoints.map((item) => item.checkpointId)).toContain(
    sourceCheckpointId
  )
})

it('在新分支继续生成不改来源草稿、来源记录或正式作品', async () => {
  const f = await generationFixture({
    scriptForWrite: (writes) => (writes === 1 ? validScript : forkScript)
  })
  const operation = await f.app.generation.generateScene({ ...request, reviewCandidate: true })
  await f.run()
  const source = (await f.app.ports.executions.readExecution(request))!
  const sourceWorkspace = new AiProjectFileSystemImpl(f.config.userStateRoot).locateWorkspace(
    source
  )
  await f.app.generation.forkSceneGeneration({
    ...operation,
    operationId: 'fork-operation',
    checkpointId: source.checkpointId!,
    policy: request.policy,
    reviewCandidate: true
  })
  await f.run()
  const forked = (await f.app.ports.executions.readExecution({
    projectId: request.projectId,
    sceneId: request.sceneId,
    operationId: 'fork-operation'
  }))!
  const interaction = forked.interaction!
  const modelCallsBeforeRevision = f.bodies.length
  await f.app.generation.replySceneGenerationInteraction({
    projectId: forked.projectId,
    sceneId: forked.sceneId,
    operationId: forked.operationId,
    threadId: forked.threadId,
    branchId: forked.branchId,
    interactionId: interaction.interactionId,
    checkpointId: interaction.checkpointId,
    candidateSnapshotId: interaction.candidateSnapshotId!,
    replyId: 'fork-revise',
    reply: { kind: 'revise', body: '改成分叉后的结尾' }
  })
  await f.run()
  expect(f.bodies.length).toBeGreaterThan(modelCallsBeforeRevision)
  const revised = (await f.app.ports.executions.readExecution({
    projectId: request.projectId,
    sceneId: request.sceneId,
    operationId: 'fork-operation'
  }))!
  expect(revised.state).toBe('waiting')
  expect(revised.candidateSnapshotId).not.toBe(source.candidateSnapshotId)
  const revisedWorkspace = new AiProjectFileSystemImpl(f.config.userStateRoot).locateWorkspace(
    revised
  )
  expect(await readFile(join(revisedWorkspace.rootDirectory, 'game/scene/start.txt'), 'utf8')).toBe(
    forkScript
  )
  expect(await readFile(join(sourceWorkspace.rootDirectory, 'game/scene/start.txt'), 'utf8')).toBe(
    validScript
  )
  expect(await f.app.ports.executions.readExecution(request)).toEqual(source)
  expect(await readFile(join(f.projectRoot, 'game/scene/start.txt'), 'utf8')).toBe('say:原稿;')
  // 来源分支的候选修订仍然可读，没有被新分支覆盖。
  const sourceCandidate = await f.app.ports.artifacts.readCandidate(
    source,
    source.candidateSnapshotId!
  )
  expect(sourceCandidate.candidateSnapshotId).toBe(source.candidateSnapshotId)
})

it('分叉更换输入时复制来源候选与新授权素材，只在来源之外继续一次修复', async () => {
  const f = await generationFixture({
    extraAssets: [
      {
        assetId: 'platform',
        name: '站台',
        relativePath: 'assets/background/platform.svg',
        svg: platformSvg
      }
    ],
    scriptForWrite: (writes) =>
      writes === 1 ? validScript : 'changeBg:platform.svg;\n林:到了。;\nend;'
  })
  const operation = await f.app.generation.generateScene({ ...request, reviewCandidate: true })
  await f.run()
  const source = (await f.app.ports.executions.readExecution(request))!
  const sourceWorkspace = new AiProjectFileSystemImpl(f.config.userStateRoot).locateWorkspace(
    source
  )
  await f.app.generation.forkSceneGeneration({
    ...operation,
    operationId: 'fork-input',
    checkpointId: source.checkpointId!,
    policy: request.policy,
    reviewCandidate: true,
    inputChanges: { canvasId: 'canvas-platform', confirmedControls: [] }
  })
  await f.run()
  const forked = (await f.app.ports.executions.readExecution({
    projectId: request.projectId,
    sceneId: request.sceneId,
    operationId: 'fork-input'
  }))!
  const forkedWorkspace = new AiProjectFileSystemImpl(f.config.userStateRoot).locateWorkspace(
    forked
  )
  expect(forked.inputSnapshot.canvasId).toBe('canvas-platform')
  expect(forked.inputSnapshot.assets.map((asset) => asset.relativePath)).toContain(
    'assets/background/platform.svg'
  )
  expect(
    await readFile(join(forkedWorkspace.rootDirectory, 'assets/background/platform.svg'), 'utf8')
  ).toBe(platformSvg)
  expect(forked.candidateSnapshotId).not.toBe(source.candidateSnapshotId)
  expect(forked.fork?.candidateSnapshotId).toBe(source.candidateSnapshotId)
  expect(await readFile(join(forkedWorkspace.rootDirectory, 'game/scene/start.txt'), 'utf8')).toBe(
    'changeBg:platform.svg;\n林:到了。;\nend;'
  )
  // 来源草稿、来源记录和正式作品保持原样。
  expect(await readFile(join(sourceWorkspace.rootDirectory, 'game/scene/start.txt'), 'utf8')).toBe(
    validScript
  )
  expect(await f.app.ports.executions.readExecution(request)).toEqual(source)
  expect(await readFile(join(f.projectRoot, 'game/scene/start.txt'), 'utf8')).toBe('say:原稿;')
})

it('副作用回执不明或来源身份不符时拒绝分叉，不复制也不调用模型', async () => {
  const f = await generationFixture()
  const operation = await f.app.generation.generateScene({ ...request, reviewCandidate: true })
  await f.run()
  const source = (await f.app.ports.executions.readExecution(request))!
  const stateRoot = join(f.config.userStateRoot, 'ai')

  await writeDurableEffect(stateRoot, source, {
    operationId: source.operationId,
    stepId: 'repair-9',
    inputDigest: 'unknown-input',
    status: 'started',
    kind: 'fileWrite'
  })
  const history = await f.app.history.listSceneGenerationHistory({ ...operation, limit: 20 })
  expect(history.checkpoints).toContainEqual(
    expect.objectContaining({
      checkpointId: source.checkpointId,
      canFork: false,
      reason: '副作用结果尚未确认，不能分叉'
    })
  )
  const modelCalls = f.bodies.length
  await expect(
    f.app.generation.forkSceneGeneration({
      ...operation,
      operationId: 'fork-started',
      checkpointId: source.checkpointId!,
      policy: request.policy,
      reviewCandidate: true
    })
  ).rejects.toMatchObject({ code: 4103 })
  expect(f.bodies).toHaveLength(modelCalls)
  expect(
    await f.app.ports.executions.readExecution({
      projectId: request.projectId,
      sceneId: request.sceneId,
      operationId: 'fork-started'
    })
  ).toBeNull()

  // 其它操作的边界标识不能冒充本操作历史。
  await expect(
    f.app.history.readSceneGenerationCheckpoint({
      ...operation,
      checkpointId: `pi-review-other-operation-${source.candidateSnapshotId}`
    })
  ).rejects.toMatchObject({ code: 4101 })
  await expect(
    f.app.generation.forkSceneGeneration({
      ...operation,
      operationId: 'fork-missing',
      checkpointId: 'pi-review-missing-operation-none',
      policy: request.policy,
      reviewCandidate: true
    })
  ).rejects.toMatchObject({ code: 4101 })
  expect(f.bodies).toHaveLength(modelCalls)
})

it('分叉按交互身份替换旧决定，新分支只保留新要求', async () => {
  const f = await generationFixture({
    scriptForWrite: (writes) => (writes === 1 ? validScript : forkScript)
  })
  const operation = await f.app.generation.generateScene({ ...request, reviewCandidate: true })
  await f.run()
  const first = (await f.app.ports.executions.readExecution(request))!
  const firstInteraction = first.interaction!
  const oldBody = '告别后留在车站'
  await f.app.generation.replySceneGenerationInteraction({
    projectId: first.projectId,
    sceneId: first.sceneId,
    operationId: first.operationId,
    threadId: first.threadId,
    branchId: first.branchId,
    interactionId: firstInteraction.interactionId,
    checkpointId: firstInteraction.checkpointId,
    candidateSnapshotId: firstInteraction.candidateSnapshotId,
    replyId: 'stay-at-station',
    reply: { kind: 'revise', body: oldBody }
  })
  await f.run()
  const changed = (await f.app.ports.executions.readExecution(request))!
  expect(changed.state).toBe('waiting')
  expect(changed.replies).toHaveLength(1)
  const modelCallsBeforeFork = f.bodies.length
  const newBody = '告别后各自回家'

  await f.app.generation.forkSceneGeneration({
    ...operation,
    operationId: 'fork-decision',
    checkpointId: changed.checkpointId!,
    policy: request.policy,
    reviewCandidate: true,
    decisionChanges: [
      { interactionId: firstInteraction.interactionId, reply: { kind: 'revise', body: newBody } }
    ]
  })
  await f.run()

  const forked = (await f.app.ports.executions.readExecution({
    projectId: request.projectId,
    sceneId: request.sceneId,
    operationId: 'fork-decision'
  }))!
  expect(forked.replies).toHaveLength(1)
  expect(forked.replies[0]).toMatchObject({
    interactionId: firstInteraction.interactionId,
    reply: { kind: 'revise', body: newBody }
  })
  expect(JSON.stringify(forked.replies)).not.toContain(oldBody)
  expect(await f.app.ports.executions.readExecution(request)).toEqual(changed)
  const requests = f.bodies
    .slice(modelCallsBeforeFork)
    .map((body) => JSON.stringify(body.messages))
  expect(requests.some((body) => body.includes(newBody))).toBe(true)
  expect(requests.every((body) => !body.includes(oldBody))).toBe(true)
})

it('历史详情比较相邻候选修订，返回真实文件摘要差异（当前 Pi 缺口）', async () => {
  const f = await generationFixture({ repair: true })
  const operation = await f.app.generation.generateScene(request)
  await f.run()
  const history = await f.app.history.listSceneGenerationHistory({ ...operation, limit: 20 })
  expect(history.checkpoints.length).toBeGreaterThan(0)
  const changed = history.checkpoints
    .flatMap((item) => item.differences)
    .find((item) => item.filePath === 'game/scene/start.txt')
  expect(changed).toBeDefined()
  expect(changed?.beforeDigest).toMatch(/^[0-9a-f]{64}$/)
  expect(changed?.afterDigest).toMatch(/^[0-9a-f]{64}$/)
  expect(changed?.beforeDigest).not.toBe(changed?.afterDigest)
})

it('分叉首次修改相对来源候选保留修改前摘要（当前 Pi 缺口）', async () => {
  const f = await generationFixture({
    scriptForWrite: (writes) =>
      writes === 1 ? validScript : validScript.replace('明天见', '后天见')
  })
  const operation = await f.app.generation.generateScene({ ...request, reviewCandidate: true })
  await f.run()
  const source = (await f.app.ports.executions.readExecution(request))!
  const fork = await f.app.generation.forkSceneGeneration({
    ...operation,
    operationId: 'fork-line',
    checkpointId: source.checkpointId!,
    policy: request.policy,
    reviewCandidate: true,
    inputChanges: { canvasId: 'canvas-1', confirmedControls: [] }
  })
  await f.run()
  const history = await f.app.history.listSceneGenerationHistory({ ...fork, limit: 20 })
  expect(history.checkpoints.length).toBeGreaterThan(0)
  const changed = history.checkpoints
    .flatMap((item) => item.differences)
    .find((item) => item.filePath === 'game/scene/start.txt')
  expect(changed).toBeDefined()
  expect(changed?.beforeDigest).toMatch(/^[0-9a-f]{64}$/)
  expect(changed?.afterDigest).toMatch(/^[0-9a-f]{64}$/)
  expect(changed?.beforeDigest).not.toBe(changed?.afterDigest)
})
