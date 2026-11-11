import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { SceneGenerationExecution } from '@application/scene-generation/models/SceneGenerationExecution'
import { SCENE_GENERATION_START_CONFLICT_MESSAGE } from '@application/scene-generation/policies/SceneGenerationStartConflict'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { FileSceneGenerationExecutionRepositoryImpl } from '@infrastructure/scene-generation/execution/FileSceneGenerationExecutionRepositoryImpl'

const roots: string[] = []
const second = { operationId: 'operation-2', threadId: 'thread-2', branchId: 'branch-2' }
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function repository(): Promise<FileSceneGenerationExecutionRepositoryImpl> {
  const stateRoot = await mkdtemp(join(tmpdir(), 'execution-start-conflict-'))
  roots.push(stateRoot)
  return new FileSceneGenerationExecutionRepositoryImpl(stateRoot)
}

describe('创建执行记录时的场景生成守卫', () => {
  it('同场景已有进行中的生成时拒绝新的生成', async () => {
    const repo = await repository()
    await repo.createExecution(execution())

    await expect(
      repo.createExecution(execution(second))
    ).rejects.toMatchObject({
      code: ErrorCodes.operationConflict,
      message: SCENE_GENERATION_START_CONFLICT_MESSAGE
    })
    await expect(repo.listSceneExecutions(sceneRequest())).resolves.toHaveLength(1)
  })

  it('分叉等没有 generate 模式的进行中记录不阻塞新的生成', async () => {
    const repo = await repository()
    await repo.createExecution(execution({ mode: undefined }))

    await expect(
      repo.createExecution(execution(second))
    ).resolves.toMatchObject({ operationId: 'operation-2' })
    await expect(repo.listSceneExecutions(sceneRequest())).resolves.toHaveLength(2)
  })

  it('修复模式不占用场景生成位置', async () => {
    const repo = await repository()
    await repo.createExecution(execution({ mode: 'repair' }))

    await expect(
      repo.createExecution(execution(second))
    ).resolves.toMatchObject({ operationId: 'operation-2' })
  })

  it('已有生成进入终态后允许新的生成', async () => {
    const repo = await repository()
    await repo.createExecution(execution({ state: 'succeeded' }))

    await expect(
      repo.createExecution(execution(second))
    ).resolves.toMatchObject({ operationId: 'operation-2' })
  })

  it('其他场景的进行中生成不阻塞本场景', async () => {
    const repo = await repository()
    await repo.createExecution(execution({ sceneId: 'scene-2' }))

    await expect(
      repo.createExecution(execution(second))
    ).resolves.toMatchObject({ operationId: 'operation-2' })
  })
})

function sceneRequest() {
  return { projectId: 'project-1', sceneId: 'scene-1', limit: 100 }
}

function execution(
  overrides: Partial<SceneGenerationExecution> = {}
): SceneGenerationExecution {
  return {
    projectId: 'project-1',
    sceneId: 'scene-1',
    operationId: 'operation-1',
    threadId: 'thread-1',
    branchId: 'branch-1',
    fingerprint: 'fingerprint-1',
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
    mode: 'generate',
    replies: [],
    ...overrides
  }
}
