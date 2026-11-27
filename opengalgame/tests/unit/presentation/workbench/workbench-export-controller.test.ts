// @vitest-environment jsdom

import { act, createElement, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SceneExportResultVO } from '@application/scene-export/vo/SceneExportVO'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { SceneExportClient } from '@interfaces/scene-export/client/SceneExportClient'
import type { WorkbenchCommands } from '@presentation/features/workbench-session/workbenchCommands'
import { useWorkbenchSessionStore } from '@presentation/features/workbench-session/workbenchSession.store'
import {
  useWorkbenchExportController,
  type WorkbenchExportController
} from '@presentation/pages/workbench/shell/useWorkbenchExportController'

type ControllerOptions = Parameters<typeof useWorkbenchExportController>[0]

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const basis = { digest: 'content-digest', parserVersion: '4.6.5', engineVersion: '4.6.5' }

function startWorkbench(): void {
  useWorkbenchSessionStore.getState().reset()
  useWorkbenchSessionStore.getState().startSession({
    projectId: 'project-1',
    projectName: '未寄出的第二封信',
    sceneId: 'scene-1',
    canvasId: 'canvas-1'
  })
  useWorkbenchSessionStore.getState().setArrangement({
    projectId: 'project-1',
    sceneId: 'scene-1',
    canvasId: 'canvas-1',
    viewport: { x: 0, y: 0, zoom: 1 },
    cards: [],
    relations: []
  })
}

function clientStub(exportResult: () => Promise<AjaxResult<SceneExportResultVO>>): SceneExportClient {
  return {
    readLatestSavedSceneVersion: vi.fn(async () => ({
      code: ErrorCodes.success,
      msg: 'ok',
      data: null
    })),
    exportSavedScene: vi.fn(exportResult),
    chooseSceneExportDirectory: vi.fn()
  } as unknown as SceneExportClient
}

function Probe({
  options,
  expose
}: {
  options: ControllerOptions
  expose: (controller: WorkbenchExportController) => void
}): ReactElement | null {
  expose(useWorkbenchExportController(options))
  return null
}

async function render(
  client: SceneExportClient,
  callbacks: Pick<ControllerOptions, 'onExported' | 'onExportFailed'> = {}
): Promise<{
  current: () => WorkbenchExportController
  unmount: () => void
}> {
  const container = document.createElement('div')
  const root = createRoot(container)
  let controller: WorkbenchExportController | null = null
  const options: ControllerOptions = {
    sceneExportClient: client,
    scope: {
      opened: { id: 'canvas-1' },
      projectId: 'project-1',
      sceneId: 'scene-1'
    },
    entry: {
      pageBlocked: false,
      workspaceBlocked: false,
      generationActive: false,
      viewStale: false,
      saveState: 'idle',
      saveLabel: '已保存'
    },
    commands: {} as WorkbenchCommands,
    refreshPreviewAvailability: vi.fn(),
    generationSettled: { succeeded: false, commitId: null, operationId: null },
    ...callbacks
  }
  await act(async () => {
    root.render(
      createElement(Probe, {
        options,
        expose: (next) => {
          controller = next
        }
      })
    )
  })
  await act(async () => {
    controller?.acceptSavedVersion(
      {
        versionReference: { kind: 'preview-save', requestId: 'request-1' },
        contentBasis: basis
      },
      { projectId: 'project-1', sceneId: 'scene-1' }
    )
  })
  return {
    current: () => {
      if (controller === null) throw new Error('预计已渲染')
      return controller
    },
    unmount: () => {
      act(() => root.unmount())
    }
  }
}

afterEach(() => {
  useWorkbenchSessionStore.getState().reset()
  vi.restoreAllMocks()
})

describe('工作台导出结果拥有方', () => {
  it('明确失败发布导出失败，普通导出页仍显示失败', async () => {
    startWorkbench()
    const onExportFailed = vi.fn()
    const onExported = vi.fn()
    const client = clientStub(async () => ({
      code: ErrorCodes.success,
      msg: 'ok',
      data: { status: 'failed', message: '打包失败' }
    }))
    const view = await render(client, { onExported, onExportFailed })

    await act(async () => {
      await view.current().runExport()
    })

    expect(onExported).not.toHaveBeenCalled()
    expect(onExportFailed).toHaveBeenCalledTimes(1)
    expect(onExportFailed).toHaveBeenCalledWith({ sceneId: 'scene-1' })
    expect(view.current().notice).toMatchObject({ tone: 'danger', label: '导出失败' })
    view.unmount()
  })

  it('通信中断只保留本机未知，不向教程宣告这次没有导出成功', async () => {
    startWorkbench()
    const onExportFailed = vi.fn()
    const onExported = vi.fn()
    const client = clientStub(async () => {
      throw new AppException({
        code: ErrorCodes.communicationFailed,
        msg: '与主进程通信失败，操作结果待确认'
      })
    })
    const view = await render(client, { onExported, onExportFailed })

    await act(async () => {
      await view.current().runExport()
    })

    expect(onExported).not.toHaveBeenCalled()
    expect(onExportFailed).not.toHaveBeenCalled()
    expect(view.current().notice).toMatchObject({
      tone: 'danger',
      label: '导出失败',
      detail: '与主进程通信失败，操作结果待确认'
    })
    view.unmount()
  })

  it('响应缺失也不当作确定失败，但保留原导出页提示', async () => {
    startWorkbench()
    const onExportFailed = vi.fn()
    const client = clientStub(async () => ({ code: ErrorCodes.success, msg: 'ok' }))
    const view = await render(client, { onExportFailed })

    await act(async () => {
      await view.current().runExport()
    })

    expect(onExportFailed).not.toHaveBeenCalled()
    expect(view.current().notice).toMatchObject({ tone: 'danger', label: '导出失败' })
    view.unmount()
  })
})
