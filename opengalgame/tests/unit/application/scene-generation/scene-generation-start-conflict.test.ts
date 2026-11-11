import { describe, expect, it } from 'vitest'

import type { SceneGenerationExecution } from '@application/scene-generation/models/SceneGenerationExecution'
import { SCENE_GENERATION_START_CONFLICT_MESSAGE } from '@application/scene-generation/policies/SceneGenerationStartConflict'
import type { SceneGenerationRenderDependencies } from '@application/scene-generation/services/impl/SceneGenerationRenderDependencies'
import { SceneGenerationLaunchServiceImpl } from '@application/scene-generation/services/impl/SceneGenerationLaunchServiceImpl'
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

/** 只提供启动用例走到生成服务所需的编排事实，不接真实画布或预览。 */
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

function launchService(f: SceneGenerationTestFixture): SceneGenerationLaunchServiceImpl {
  return new SceneGenerationLaunchServiceImpl(
    f.deps,
    renderDependencies(),
    f.generation,
    f.coordinator
  )
}

/** 先创建一条真实生成记录，再改成测试需要的状态或模式。 */
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
    // 分叉执行不写 mode；这里显式清空以模拟分叉记录。
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
