import { describe, expect, it, vi } from 'vitest'

import type { SceneCanvasApplicationService } from '@application/scene-canvas/services/SceneCanvasApplicationService'
import type { SceneCanvasArrangementVO } from '@application/scene-canvas/vo/SceneCanvasArrangementVO'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { LoggerGateway } from '@common/logging/LoggerGateway'
import { SceneCanvasErrorCodes } from '@domain/scene-canvas/errors/SceneCanvasErrorCodes'
import { IpcExceptionHandler } from '@interfaces/ipc/errors/IpcExceptionHandler'
import { SceneCanvasClientImpl } from '@interfaces/scene-canvas/client/SceneCanvasClientImpl'
import { SceneCanvasController } from '@interfaces/scene-canvas/ipc/SceneCanvasController'
import { registerSceneCanvasIpc } from '@interfaces/scene-canvas/ipc/registerSceneCanvasIpc'

const ipc = vi.hoisted(() => ({
  handlers: new Map<string, unknown>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: unknown) => {
      ipc.handlers.set(channel, handler)
    },
    removeHandler: (channel: string) => {
      ipc.handlers.delete(channel)
    }
  }
}))

const access = { trusted: true, requestId: 'req-1' }

function arrangement(): SceneCanvasArrangementVO {
  return {
    projectId: 'project-1',
    sceneId: 'scene-1',
    canvasId: 'canvas-1',
    viewport: { x: 0, y: 0, zoom: 1 },
    cards: [
      {
        kind: 'prompt',
        cardId: 'prompt',
        body: '',
        references: [],
        layout: { x: 0, y: 0, width: 10, height: 10 }
      }
    ],
    relations: []
  }
}

function createController(service: Partial<SceneCanvasApplicationService>): {
  controller: SceneCanvasController
  calls: string[]
} {
  const calls: string[] = []
  const logger: LoggerGateway = {
    debug: (event) => calls.push(event),
    info: (event) => calls.push(event),
    warn: (event) => calls.push(event),
    error: (event) => calls.push(event)
  }
  return {
    calls,
    controller: new SceneCanvasController(
      service as SceneCanvasApplicationService,
      new IpcExceptionHandler(logger)
    )
  }
}

describe('场景画布用户接口', () => {
  it('把创建请求分发到对应应用方法，并拒绝旧用途字段', async () => {
    const createSourceCard = vi.fn(async () => arrangement())
    const { controller } = createController({ createSourceCard })
    const request = {
      projectId: 'project-1',
      sceneId: 'scene-1',
      canvasId: 'canvas-1',
      sourceId: 'source-1',
      layout: { x: 1, y: 2, width: 10, height: 10 },
      arrangement: arrangement()
    }
    await expect(controller.createSourceCard(request, access)).resolves.toMatchObject({
      code: ErrorCodes.success,
      data: arrangement()
    })
    expect(createSourceCard).toHaveBeenCalledWith(request)
    await expect(
      controller.createSourceCard({ ...request, role: 'background' }, access)
    ).resolves.toMatchObject({ code: ErrorCodes.invalidRequest })
    expect(createSourceCard).toHaveBeenCalledTimes(1)
  })

  it('接受空正文和空预设，读取 null 与失败不同', async () => {
    const editPromptBody = vi.fn(async () => arrangement())
    const bindFieldCardPreset = vi.fn(async () => arrangement())
    const readSceneCanvasArrangement = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(
        new AppException({ code: SceneCanvasErrorCodes.contentDamaged, msg: '编排内容损坏' })
      )
    const { controller } = createController({
      editPromptBody,
      bindFieldCardPreset,
      readSceneCanvasArrangement
    })
    const request = {
      projectId: 'project-1',
      sceneId: 'scene-1',
      canvasId: 'canvas-1',
      arrangement: arrangement()
    }
    await expect(
      controller.editPromptBody({ ...request, cardId: 'prompt', body: '' }, access)
    ).resolves.toMatchObject({ code: ErrorCodes.success })
    await expect(
      controller.bindFieldCardPreset({ ...request, cardId: 'effect', preset: null }, access)
    ).resolves.toMatchObject({ code: ErrorCodes.success })
    await expect(
      controller.readSceneCanvasArrangement(
        { projectId: 'project-1', sceneId: 'scene-1', canvasId: 'canvas-1' },
        access
      )
    ).resolves.toMatchObject({ code: ErrorCodes.success, data: null })
    await expect(
      controller.readSceneCanvasArrangement(
        { projectId: 'project-1', sceneId: 'scene-1', canvasId: 'canvas-1' },
        access
      )
    ).resolves.toMatchObject({ code: SceneCanvasErrorCodes.contentDamaged, msg: '编排内容损坏' })
  })

  it('保存成功映射为 null，三类保存错误保留错误码', async () => {
    const saveSceneCanvasArrangement = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(
        new AppException({ code: SceneCanvasErrorCodes.persistFailed, msg: '编排没能写入' })
      )
      .mockRejectedValueOnce(
        new AppException({
          code: SceneCanvasErrorCodes.commitFailed,
          msg: '编排已落盘，但还没进入作品修订'
        })
      )
      .mockRejectedValueOnce(
        new AppException({ code: SceneCanvasErrorCodes.commitUnknown, msg: '编排提交结果尚未查明' })
      )
    const { controller } = createController({ saveSceneCanvasArrangement })
    const request = {
      projectId: 'project-1',
      sceneId: 'scene-1',
      canvasId: 'canvas-1',
      reason: 'manual',
      arrangement: arrangement()
    }
    await expect(controller.saveSceneCanvasArrangement(request, access)).resolves.toMatchObject({
      code: ErrorCodes.success,
      data: null
    })
    await expect(controller.saveSceneCanvasArrangement(request, access)).resolves.toMatchObject({
      code: SceneCanvasErrorCodes.persistFailed
    })
    await expect(controller.saveSceneCanvasArrangement(request, access)).resolves.toMatchObject({
      code: SceneCanvasErrorCodes.commitFailed
    })
    await expect(controller.saveSceneCanvasArrangement(request, access)).resolves.toMatchObject({
      code: SceneCanvasErrorCodes.commitUnknown
    })
  })

  it('响应结构不符和传输中断都不是保存成功', async () => {
    const client = new SceneCanvasClientImpl({
      saveSceneCanvasArrangement: async () => ({
        code: ErrorCodes.success,
        msg: '好',
        data: arrangement()
      })
    } as never)
    await expect(
      client.saveSceneCanvasArrangement({
        projectId: 'project-1',
        sceneId: 'scene-1',
        canvasId: 'canvas-1',
        reason: 'beforeGeneration',
        arrangement: arrangement()
      })
    ).resolves.toMatchObject({ code: ErrorCodes.communicationFailed })
    const interrupted = new SceneCanvasClientImpl({
      saveSceneCanvasArrangement: async () => {
        throw new Error('bridge down')
      }
    } as never)
    await expect(
      interrupted.saveSceneCanvasArrangement({
        projectId: 'project-1',
        sceneId: 'scene-1',
        canvasId: 'canvas-1',
        reason: 'periodic',
        arrangement: arrangement()
      })
    ).resolves.toMatchObject({ code: ErrorCodes.communicationFailed })
  })

  it('注册和注销同一份通道表', () => {
    const detach = registerSceneCanvasIpc({
      sceneCanvas: {} as SceneCanvasController,
      getWindow: () => null,
      rendererUrl: 'http://127.0.0.1:5173/'
    })
    expect(ipc.handlers.has('scene-canvas:read-arrangement')).toBe(true)
    expect(ipc.handlers.has('scene-canvas:save-arrangement')).toBe(true)
    expect(ipc.handlers.has('project-files:read-canvas-arrangement')).toBe(false)
    detach()
    expect(ipc.handlers.size).toBe(0)
  })
})
