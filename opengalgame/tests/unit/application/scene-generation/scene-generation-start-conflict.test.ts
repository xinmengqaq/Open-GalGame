import { describe, expect, it } from 'vitest'

import type { SceneGenerationExecution } from '@application/scene-generation/models/SceneGenerationExecution'
import { toRenderStatusVO } from '@application/scene-generation/mapping/SceneGenerationRenderProjection'
import { SceneGenerationVersionConflict } from '@application/scene-generation/errors/SceneGenerationVersionConflict'
import { SCENE_GENERATION_START_CONFLICT_MESSAGE } from '@application/scene-generation/policies/SceneGenerationStartConflict'
import type { SceneGenerationRenderDependencies } from '@application/scene-generation/services/impl/SceneGenerationRenderDependencies'
import { LaunchSceneGeneration } from '@application/scene-generation/services/impl/LaunchSceneGeneration'
import type { SceneCanvasArrangementVO } from '@application/scene-canvas/vo/SceneCanvasArrangementVO'

import {
  createSceneGenerationFixture,
  generationRequest,
  type SceneGenerationTestFixture
} from './sceneGenerationFixture'

const startRequest = {
  projectId: 'project-1',
  sceneId: 'scene-1',
  canvasId: 'canvas-1',
  confirmedControls: [],
  policy: { maxCorrections: 2 }
}

const arrangement: SceneCanvasArrangementVO = {
  projectId: 'project-1',
  sceneId: 'scene-1',
  canvasId: 'canvas-1',
  viewport: { x: 0, y: 0, zoom: 1 },
  cards: [],
  relations: []
}

function renderDependencies(): SceneGenerationRenderDependencies {
  return {
    canvasVersions: {
      keepArrangement: async () => ({ state: 'kept' }),
      readSettlement: async () => ({ state: 'kept' }),
      readArrangementVersion: async () => ({
        projectId: 'project-1',
        sceneId: 'scene-1',
        canvasId: 'canvas-1',
        arrangementVersion: 'arrangement-1'
      })
    },
    saveArrangement: async () => {},
    readCurrentArrangement: async () => arrangement,
    production: {
      resolveRegisteredScene: async () => ({
        projectId: 'project-1',
        sceneId: 'scene-1',
        projectRoot: '/project',
        sceneDirectory: 'scenes/scene-1',
        entryFile: 'start.txt'
      })
    },
    preview: {
      openPublishedCandidatePreview: async () => {
        throw new Error('预览不属于本测试')
      },
      closeCandidatePreview: async () => {},
      invalidateCandidatePreviewSessions: async () => {},
      subscribeCandidatePreviewEvents: () => () => undefined,
      readCandidatePreviewEvent: () => undefined
    }
  }
}

function launchService(f: SceneGenerationTestFixture): LaunchSceneGeneration {
  return new LaunchSceneGeneration(
    f.deps,
    renderDependencies(),
    f.generation,
    f.coordinator
  )
}

async function seedExecution(
  f: SceneGenerationTestFixture,
  overrides: Partial<SceneGenerationExecution>
): Promise<SceneGenerationExecution> {
  const started = await f.service.generateScene(generationRequest)
  const seeded = { ...f.executions.get(started.operationId)!, ...overrides }
  f.executions.set(seeded.operationId, seeded)
  return seeded
}

describe('启动场景生成时的并发拦截', () => {
  it('场景没有进行中的生成时可以启动', async () => {
    const f = createSceneGenerationFixture()
    const status = await launchService(f).startSceneGeneration(startRequest)

    expect(status).toMatchObject({ projectId: 'project-1', sceneId: 'scene-1' })
    expect(f.executions.size).toBe(1)
    expect(f.executions.get(status.operationId)).toMatchObject({ mode: 'generate', state: 'pending' })
  })

  it.each(['pending', 'running', 'waiting', 'interrupted'] as const)(
    '已有 %s 的生成时拒绝启动，且不保存编排',
    async (state) => {
      const f = createSceneGenerationFixture()
      await seedExecution(f, { state })
      f.versions.ensureWorkspace.mockClear()

      await expect(launchService(f).startSceneGeneration(startRequest)).rejects.toMatchObject({
        code: 4103,
        message: SCENE_GENERATION_START_CONFLICT_MESSAGE
      })
      expect(f.executions.size).toBe(1)
      expect(f.versions.ensureWorkspace).not.toHaveBeenCalled()
    }
  )

  it.each(['succeeded', 'failed', 'cancelled'] as const)(
    '已有 %s 终态生成时可以启动新的生成',
    async (state) => {
      const f = createSceneGenerationFixture()
      await seedExecution(f, { state })

      const status = await launchService(f).startSceneGeneration(startRequest)

      expect(f.executions.size).toBe(2)
      expect(f.executions.get(status.operationId)).toMatchObject({
        mode: 'generate',
        state: 'pending'
      })
    }
  )

  it('分叉记录没有 generate 模式，不阻塞新的生成', async () => {
    const f = createSceneGenerationFixture()
    const seeded = await seedExecution(f, { state: 'running' })
    f.executions.set(seeded.operationId, { ...seeded, mode: undefined })

    const status = await launchService(f).startSceneGeneration(startRequest)

    expect(f.executions.size).toBe(2)
    expect(f.executions.get(status.operationId)?.mode).toBe('generate')
  })

  it('修复等非生成模式不占用场景生成位置', async () => {
    const f = createSceneGenerationFixture()
    await seedExecution(f, { state: 'running', mode: 'repair' })

    const status = await launchService(f).startSceneGeneration(startRequest)

    expect(f.executions.size).toBe(2)
    expect(f.executions.get(status.operationId)?.mode).toBe('generate')
  })
})

describe('启动前状态投影', () => {
  it('只为非终态 generate 投影阻断新生成，其他模式与终态不占位', async () => {
    const f = createSceneGenerationFixture()
    const seeded = await seedExecution(f, { state: 'pending', mode: 'generate' })

    for (const state of ['pending', 'running', 'waiting', 'interrupted'] as const) {
      expect(toRenderStatusVO({ ...seeded, state }).blocksNewGeneration).toBe(true)
    }
    for (const state of ['succeeded', 'failed', 'cancelled'] as const) {
      expect(toRenderStatusVO({ ...seeded, state }).blocksNewGeneration).toBeUndefined()
    }
    for (const mode of ['repair', 'validate', undefined] as const) {
      expect(toRenderStatusVO({ ...seeded, mode }).blocksNewGeneration).toBeUndefined()
    }
  })
})

describe('启动前候选可接受性判定', () => {
  it.each([
    ['locked', '目标场景已锁定，不能覆盖'],
    ['unknown', '目标场景锁定状态不明，不能覆盖']
  ] as const)('锁定状态为 %s 时按版本冲突拒绝启动，不创建操作', async (lockState, message) => {
    const f = createSceneGenerationFixture()
    f.versions.readBaseline.mockResolvedValue({
      commitId: 'baseline-1',
      affectedFiles: [],
      lockState
    })

    const started = f.service.generateScene(generationRequest)
    await expect(started).rejects.toBeInstanceOf(SceneGenerationVersionConflict)
    await expect(started).rejects.toMatchObject({ code: 4103, message })
    expect(f.workflow.createExecution).not.toHaveBeenCalled()
    expect(f.artifacts.createWorkspace).not.toHaveBeenCalled()
    expect(f.executions.size).toBe(0)
  })
})
