import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createWebGalGenerationGraph } from '@infrastructure/scene-generation/workflow/createWebGalGenerationGraph'
import { WebGalGenerationCheckpointSaver } from '@infrastructure/scene-generation/history/WebGalGenerationCheckpoint'
import { langGraphThreadKey } from '@infrastructure/workflow/WorkflowIdentity'
import {
  generationFixture,
  request,
  validScript
} from '../../../../harness/acceptance/support/generationFixture'

const platformSvg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#705030"/></svg>'

it('缺少应用检查点且副作用未确认时，恢复停止且不提交', async () => {
  const f = await generationFixture({ unresolved: true })
  const operation = await f.app.generation.generateScene({ ...request, reviewCandidate: true })
  await f.run()
  const execution = (await f.app.ports.executions.readExecution(request))!
  const candidateSnapshotId = execution.candidateSnapshotId!
  const effectPath = join(
    f.config.userStateRoot,
    'ai/projects',
    operation.projectId,
    'threads',
    operation.threadId,
    'operations',
    request.operationId,
    'effects/generate-0-initial.json'
  )
  const effect = JSON.parse(await readFile(effectPath, 'utf8')) as Record<string, unknown>
  delete effect.resultDigest
  delete effect.candidateRevision
  await writeFile(effectPath, JSON.stringify({ ...effect, status: 'started' }))
  await f.app.ports.executions.writeExecution({
    ...execution,
    state: 'interrupted',
    checkpointId: undefined
  })
  const count = f.bodies.length
  await f.app.generation.resumeSceneGeneration(request)
  await expect(f.run()).rejects.toThrow(/不能继续/)
  const stopped = (await f.app.ports.executions.readExecution(request))!
  expect(stopped.state).not.toBe('succeeded')
  expect(stopped.result).toBeUndefined()
  expect(stopped.candidateSnapshotId).toBe(candidateSnapshotId)
  expect(f.bodies).toHaveLength(count)
  expect(await readFile(join(f.projectRoot, 'game/scene/start.txt'), 'utf8')).toBe('say:原稿;')
  expect(f.git('rev-list', '--count', 'HEAD')).toBe('1')
})

it('已确认场景跳转按原文匹配，不把运行时路径当成可自动删除', async () => {
  const f = await generationFixture()
  await f.app.generation.generateScene({ ...request, reviewCandidate: true })
  await f.run()
  const execution = (await f.app.ports.executions.readExecution(request))!
  await f.app.candidateEdit.editSceneGenerationCandidate({
    ...request,
    candidateSnapshotId: execution.candidateSnapshotId!,
    files: [{ relativePath: 'game/scene/start.txt', content: 'callScene:next.txt;\nend;' }]
  })
  const current = (await f.app.ports.executions.readExecution(request))!
  await f.app.ports.executions.writeExecution({
    ...current,
    inputSnapshot: {
      ...current.inputSnapshot,
      confirmedControls: [{ kind: 'sceneJump', content: 'next.txt', inputId: 'story' }]
    }
  })
  const read = await f.app.ports.artifacts.readCandidate(
    (await f.app.ports.executions.readExecution(request))!,
    current.candidateSnapshotId!
  )
  expect(read.artifact.statements.find((item) => item.command === 'callScene')?.content).toBe(
    'next.txt'
  )
  expect(read.preview.validationReport.issues).toContainEqual(
    expect.objectContaining({ code: 'scene-jump', requiresHumanDecision: true })
  )
})

it('分叉选中的新素材进入候选工作区，合法引用不再缺失', async () => {
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
  const operation = await f.app.generation.generateScene(request)
  await f.run()
  const execution = (await f.app.ports.executions.readExecution(request))!
  await f.app.generation.forkSceneGeneration({
    ...operation,
    operationId: 'fork-platform',
    checkpointId: execution.checkpointId!,
    policy: request.policy,
    reviewCandidate: true,
    inputChanges: { canvasId: 'canvas-platform', confirmedControls: [] }
  })
  await f.run()
  const forked = (await f.app.ports.executions.readExecution({
    ...request,
    operationId: 'fork-platform'
  }))!
  expect(
    await readFile(join(forked.workspace!.rootDirectory, 'assets/background/platform.svg'), 'utf8')
  ).toBe(platformSvg)
  const candidate = await f.app.ports.artifacts.readCandidate(forked, forked.candidateSnapshotId!)
  expect(
    candidate.preview.validationReport.issues.some((issue) => issue.code === 'missing-asset')
  ).toBe(false)
})

it('分叉按交互身份替换旧决定，摘要不再保留被替换要求', async () => {
  const f = await generationFixture()
  const operation = await f.app.generation.generateScene({ ...request, reviewCandidate: true })
  await f.run()
  const waiting = (await f.app.ports.executions.readExecution(request))!
  const interactionId = waiting.interaction!.interactionId
  await f.app.generation.replySceneGenerationInteraction({
    projectId: waiting.projectId,
    sceneId: waiting.sceneId,
    operationId: waiting.operationId,
    threadId: waiting.threadId,
    branchId: waiting.branchId,
    interactionId,
    checkpointId: waiting.interaction!.checkpointId,
    candidateSnapshotId: waiting.interaction!.candidateSnapshotId,
    replyId: 'stay-at-station',
    reply: { kind: 'revise', body: '告别后留在车站' }
  })
  await f.run()
  const reviewed = (await f.app.ports.executions.readExecution(request))!
  await f.app.generation.replySceneGenerationInteraction({
    projectId: reviewed.projectId,
    sceneId: reviewed.sceneId,
    operationId: reviewed.operationId,
    threadId: reviewed.threadId,
    branchId: reviewed.branchId,
    interactionId: reviewed.interaction!.interactionId,
    checkpointId: reviewed.interaction!.checkpointId,
    candidateSnapshotId: reviewed.interaction!.candidateSnapshotId,
    replyId: 'accept-revised',
    reply: { kind: 'accept' }
  })
  await f.run()
  const execution = (await f.app.ports.executions.readExecution(request))!
  const stateRoot = join(f.config.userStateRoot, 'ai')
  const graph = createWebGalGenerationGraph({
    stateRoot,
    saver: new WebGalGenerationCheckpointSaver(stateRoot),
    artifacts: f.app.ports.artifacts
  })
  const updated = await graph.updateState(
    { configurable: { thread_id: langGraphThreadKey(execution) } },
    {
      summary: '道别后继续待在站内，不回家',
      memoryMessages: [{ id: 'old-decision', role: 'user', content: '告别后留在车站' }]
    }
  )
  const count = f.bodies.length
  await f.app.generation.forkSceneGeneration({
    ...operation,
    operationId: 'fork-decision',
    checkpointId: String(updated.configurable!.checkpoint_id),
    policy: request.policy,
    reviewCandidate: true,
    decisionChanges: [{ interactionId, reply: { kind: 'revise', body: '告别后各自回家' } }]
  })
  await f.run()
  const requests = f.bodies
    .slice(count)
    .map((body) => JSON.stringify(body.messages))
    .filter((body) => !body.includes('Context Extraction Assistant'))
  expect(requests.some((body) => body.includes('告别后各自回家'))).toBe(true)
  expect(requests.every((body) => !body.includes('告别后留在车站'))).toBe(true)
  expect(requests.every((body) => !body.includes('道别后继续待在站内，不回家'))).toBe(true)
}, 20000)

it('分叉首次修改相对来源候选保留修改前摘要', async () => {
  const f = await generationFixture({
    scriptForWrite: (writes) =>
      writes === 1 ? validScript : validScript.replace('明天见', '后天见')
  })
  const operation = await f.app.generation.generateScene(request)
  await f.run()
  const execution = (await f.app.ports.executions.readExecution(request))!
  const fork = await f.app.generation.forkSceneGeneration({
    ...operation,
    operationId: 'fork-line',
    checkpointId: execution.checkpointId!,
    policy: request.policy,
    reviewCandidate: true,
    inputChanges: { canvasId: 'canvas-1', confirmedControls: [] }
  })
  await f.run()
  const history = await f.app.history.listSceneGenerationHistory({ ...fork, limit: 20 })
  const changed = history.checkpoints
    .flatMap((item) => item.differences)
    .find((item) => item.filePath === 'game/scene/start.txt')
  expect(changed?.beforeDigest).toMatch(/^[0-9a-f]{64}$/)
  expect(changed?.afterDigest).toMatch(/^[0-9a-f]{64}$/)
  expect(changed?.beforeDigest).not.toBe(changed?.afterDigest)
})

it('历史详情比较相邻候选修订，返回真实文件摘要差异', async () => {
  const f = await generationFixture({ repair: true })
  const operation = await f.app.generation.generateScene(request)
  await f.run()
  const history = await f.app.history.listSceneGenerationHistory({ ...operation, limit: 20 })
  const changed = history.checkpoints
    .flatMap((item) => item.differences)
    .find((item) => item.filePath === 'game/scene/start.txt')
  expect(changed?.beforeDigest).toMatch(/^[0-9a-f]{64}$/)
  expect(changed?.afterDigest).toMatch(/^[0-9a-f]{64}$/)
  expect(changed?.beforeDigest).not.toBe(changed?.afterDigest)
})

it('两次实际写入后尝试次数为 2', async () => {
  const f = await generationFixture({ repair: true })
  await f.app.generation.generateScene(request)
  await f.run()
  expect(f.writes()).toBe(2)
  expect((await f.app.ports.executions.readExecution(request))?.attempt).toBe(2)
  expect((await f.app.status.getSceneGenerationStatus(request)).attempt).toBe(2)
})

it('单次生成的尝试次数仍为 1', async () => {
  const f = await generationFixture()
  await f.app.generation.generateScene(request)
  await f.run()
  expect(f.writes()).toBe(1)
  expect((await f.app.status.getSceneGenerationStatus(request)).attempt).toBe(1)
})
