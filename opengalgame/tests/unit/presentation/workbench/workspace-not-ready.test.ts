import { afterEach, describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'

import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import type { ProjectClient } from '@interfaces/client/ProjectClient'
import type { ProjectFilesClient } from '@interfaces/project-files/client/ProjectFilesClient'
import type { SceneCanvasClient } from '@interfaces/scene-canvas/client/SceneCanvasClient'
import type { SceneGenerationClient } from '@interfaces/scene-generation/client/SceneGenerationClient'
import { PROJECT_WORKSPACE_NOT_READY_CODE } from '@presentation/feedback/workbenchFeedback'
import { useWorkbenchSessionStore } from '@presentation/features/workbench-session/workbenchSession.store'
import { useNavigationStore } from '@presentation/stores/navigation.store'
import {
  prepareGenerationWorkspace,
  readGenerationHistory
} from '@presentation/pages/workbench/drawer/generation/useSceneGeneration'
import {
  beginWorkspaceRebuild,
  ensureOpenedWorkspace,
  rebuildOpenedWorkspace,
  refreshSources,
  type WorkspaceRebuildPhase
} from '@presentation/pages/workbench/useWorkbenchPage'

function ok<T>(data: T): AjaxResult<T> {
  return { code: ErrorCodes.success, msg: 'ok', data }
}

function files(): ProjectFilesClient {
  return {
    listProjectInputSources: async () =>
      ok({ projectId: 'p-01', catalogVersion: 'v', folders: [], sources: [] })
  } as unknown as ProjectFilesClient
}

function canvas(): SceneCanvasClient {
  return {
    readSceneCanvasArrangement: async () => ok(null)
  } as unknown as SceneCanvasClient
}

describe('工作区未就绪', () => {
  afterEach(() => {
    useWorkbenchSessionStore.getState().reset()
    useNavigationStore.setState({ page: 'home', openedProject: null })
  })

  it('显式补建失败时不读取画布，1309 只留下安全文案', async () => {
    const sceneCanvas = { readSceneCanvasArrangement: vi.fn() } as unknown as SceneCanvasClient
    const projectFiles = { listProjectInputSources: vi.fn() } as unknown as ProjectFilesClient
    const projects = {
      ensureProjectWorkspace: async () => ({
        code: PROJECT_WORKSPACE_NOT_READY_CODE,
        msg: 'D:/secret/.git 损坏'
      })
    } as unknown as ProjectClient

    const ready = await ensureOpenedWorkspace(
      projects,
      sceneCanvas,
      projectFiles,
      new QueryClient(),
      'p-01',
      '未寄出的第二封信'
    )

    expect(ready).toBe(false)
    expect(sceneCanvas.readSceneCanvasArrangement).not.toHaveBeenCalled()
    expect(projectFiles.listProjectInputSources).not.toHaveBeenCalled()
    expect(useWorkbenchSessionStore.getState().arrangementError).toEqual({
      code: PROJECT_WORKSPACE_NOT_READY_CODE,
      msg: '工程初始化未完成，请重新构建'
    })
    expect(JSON.stringify(useWorkbenchSessionStore.getState().arrangementError)).not.toContain(
      'D:/secret'
    )
  })

  it('重建中只调用一次，失败后恢复可重试，成功后重新读取画布', async () => {
    useNavigationStore.getState().openWorkbench({ id: 'p-01', name: '未寄出的第二封信' })
    let attempts = 0
    let release: (() => void) | null = null
    const projects = {
      ensureProjectWorkspace: () => {
        attempts += 1
        if (attempts === 1) {
          const gate = Promise.withResolvers<AjaxResult<never>>()
          release = () =>
            gate.resolve({ code: PROJECT_WORKSPACE_NOT_READY_CODE, msg: '内部锁损坏' })
          return gate.promise
        }
        return Promise.resolve(
          ok({ projectId: 'p-01', sceneId: 'scene-returned', canvasId: 'canvas-returned' })
        )
      }
    } as unknown as ProjectClient
    const phases: WorkspaceRebuildPhase[] = []
    const lock = { current: false }
    const run = (): Promise<boolean> => {
      if (!beginWorkspaceRebuild(lock)) return Promise.resolve(false)
      return rebuildOpenedWorkspace(
        projects,
        files(),
        canvas(),
        new QueryClient(),
        'p-01',
        '未寄出的第二封信',
        () => true,
        (phase) => phases.push(phase)
      ).finally(() => {
        lock.current = false
      })
    }
    const first = run()
    const repeated = run()
    expect(phases.filter((phase) => phase === 'rebuilding')).toHaveLength(1)
    expect(attempts).toBe(1)
    release?.()
    await Promise.all([first, repeated])
    expect(useWorkbenchSessionStore.getState().arrangementError?.msg).toBe(
      '工程初始化未完成，请重新构建'
    )

    const recovered = await rebuildOpenedWorkspace(
      projects,
      files(),
      canvas(),
      new QueryClient(),
      'p-01',
      '未寄出的第二封信',
      () => true,
      (phase) => phases.push(phase)
    )

    expect(recovered).toBe(true)
    expect(phases).toContain('failed')
    expect(phases).toContain('loaded')
    expect(useWorkbenchSessionStore.getState()).toMatchObject({
      sceneId: 'scene-returned',
      canvasId: 'canvas-returned',
      arrangementStatus: 'empty',
      arrangementError: null
    })
  })

  it('已有未保存编辑时重新构建不覆盖画布', async () => {
    const store = useWorkbenchSessionStore.getState()
    store.startSession({
      projectId: 'p-01',
      projectName: '未寄出的第二封信',
      sceneId: 'scene-1',
      canvasId: 'canvas-1'
    })
    store.setArrangementEmpty()
    store.setViewport({ x: 4, y: 5, zoom: 1.2 })
    store.markSaveFailure('failed', {
      code: PROJECT_WORKSPACE_NOT_READY_CODE,
      msg: '工程初始化未完成，请重新构建'
    })
    const read = vi.fn(async () => ok(null))
    const projects = {
      ensureProjectWorkspace: async () =>
        ok({ projectId: 'p-01', sceneId: 'scene-1', canvasId: 'canvas-1' })
    } as unknown as ProjectClient

    const recovered = await rebuildOpenedWorkspace(
      projects,
      files(),
      { readSceneCanvasArrangement: read } as unknown as SceneCanvasClient,
      new QueryClient(),
      'p-01',
      '未寄出的第二封信',
      () => true,
      () => undefined
    )

    expect(recovered).toBe(true)
    expect(read).not.toHaveBeenCalled()
    expect(useWorkbenchSessionStore.getState().viewport).toEqual({ x: 4, y: 5, zoom: 1.2 })
    expect(useWorkbenchSessionStore.getState().saveError).toBeNull()
    expect(useWorkbenchSessionStore.getState().saveState).toBe('dirty')
  })

  it('来源刷新不核对工作区', async () => {
    useWorkbenchSessionStore.getState().startSession({
      projectId: 'p-01',
      projectName: '未寄出的第二封信',
      sceneId: 'scene-1',
      canvasId: 'canvas-1'
    })
    const ensure = vi.fn()
    const projectFiles = {
      ensureProjectWorkspace: ensure,
      listProjectInputSources: async () =>
        ok({ projectId: 'p-01', catalogVersion: 'v', folders: [], sources: [] })
    } as unknown as ProjectFilesClient

    await refreshSources(projectFiles, new QueryClient(), 'p-01')

    expect(ensure).not.toHaveBeenCalled()
  })

  it('生成启动遇到 1309 只返回安全文案，历史和状态查询不核对工作区', async () => {
    const ensure = vi.fn(async () => ({
      code: PROJECT_WORKSPACE_NOT_READY_CODE,
      msg: '锁文件损坏：D:/secret/.opengalgame/scene-locks.json'
    }))
    const prepared = await prepareGenerationWorkspace(
      { ensureProjectWorkspace: ensure } as unknown as ProjectClient,
      'p-01'
    )

    expect(prepared).toEqual({
      ok: false,
      message: '工程初始化未完成，请重新构建',
      workspaceNotReady: true
    })
    expect(JSON.stringify(prepared)).not.toContain('D:/secret')
    expect(JSON.stringify(prepared)).not.toContain('scene-locks')

    const listHistory = vi.fn(async () => ok([]))
    const latest = vi.fn(async () => ok(null))
    const status = vi.fn()
    const history = await readGenerationHistory(
      { listHistory, latest, status } as unknown as SceneGenerationClient,
      'p-01',
      'scene-1'
    )

    expect(history).toEqual({ kind: 'empty' })
    expect(listHistory).toHaveBeenCalledTimes(1)
    expect(latest).toHaveBeenCalledTimes(1)
    expect(status).not.toHaveBeenCalled()
    expect(ensure).toHaveBeenCalledTimes(1)
  })
})
