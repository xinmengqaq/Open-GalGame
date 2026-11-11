import { describe, expect, it, vi } from 'vitest'

import type { ExportSavedSceneDTO } from '@application/scene-export/dto/ExportSavedSceneDTO'
import type { ReadLatestPreviewSaveService } from '@application/scene-export/services/ReadLatestPreviewSaveUseCase'
import type { SceneExportApplicationService } from '@application/scene-export/services/SceneExportApplicationService'
import type { PreviewSaveVersionVO } from '@application/scene-export/vo/PreviewSaveVersionVO'
import type { SceneExportResultVO } from '@application/scene-export/vo/SceneExportVO'
import type { OpenDirectoryApplicationService } from '@application/system-path/services/OpenDirectoryApplicationService'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { LoggerGateway } from '@common/logging/LoggerGateway'
import { createBrowserDesktopBridge } from '@bootstrap/browser/BrowserDesktopBridge'
import { SceneExportErrorCodes } from '@domain/scene-export/errors/SceneExportErrorCodes'
import { SystemPathErrorCodes } from '@domain/system-path/errors/SystemPathErrorCodes'
import { IpcExceptionHandler } from '@interfaces/ipc/errors/IpcExceptionHandler'
import { createDesktopBridge } from '@interfaces/preload/DesktopBridge'
import { SceneExportClientImpl } from '@interfaces/scene-export/client/SceneExportClientImpl'
import { SceneExportController } from '@interfaces/scene-export/ipc/SceneExportController'
import { registerSceneExportIpc } from '@interfaces/scene-export/ipc/registerSceneExportIpc'
import { SystemPathController } from '@interfaces/system-path/ipc/SystemPathController'
import { registerSystemPathIpc } from '@interfaces/system-path/ipc/registerSystemPathIpc'

const ipc = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, input: unknown) => Promise<unknown>>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, input: unknown) => Promise<unknown>) => {
      ipc.handlers.set(channel, handler)
    },
    removeHandler: (channel: string) => {
      ipc.handlers.delete(channel)
    }
  },
  webUtils: { getPathForFile: () => '' }
}))

const access = { trusted: true, requestId: 'req-1' }
const denied = { trusted: false, requestId: 'req-2' }
const fixedChannels = ['scene-export:export-saved-scene', 'scene-export:read-latest-preview-save']

function request(): ExportSavedSceneDTO {
  return {
    projectId: 'project-1',
    sceneId: 'scene-1',
    contentBasis: { digest: 'digest-1', parserVersion: '4.6.5', engineVersion: '4.6.5' },
    versionReference: { kind: 'preview-save', requestId: 'request-1' }
  }
}

function previewVersion(): PreviewSaveVersionVO {
  return {
    requestId: 'request-1',
    revisionDigest: 'a'.repeat(64),
    contentBasis: request().contentBasis
  }
}

function unavailable(): SceneExportResultVO {
  return {
    status: 'unavailable',
    reason: 'windowsPackagerUnavailable',
    message: '当前没有可调用的 Windows 桌面打包入口'
  }
}

function loggerOf(): { logger: LoggerGateway; logs: string[] } {
  const logs: string[] = []
  const logger: LoggerGateway = {
    debug: (message) => logs.push(message),
    info: (message) => logs.push(message),
    warn: (message) => logs.push(message),
    error: (message, context) => logs.push(`${message}:${JSON.stringify(context)}`)
  }
  return { logger, logs }
}

function controller(
  exportSavedScene: SceneExportApplicationService['exportSavedScene'] = vi.fn(
    async () => unavailable()
  ),
  latestPreviewSave: ReadLatestPreviewSaveService = { readLatestPreviewSave: vi.fn(async () => null) }
): {
  controller: SceneExportController
  exportSavedScene: typeof exportSavedScene
  latestPreviewSave: ReadLatestPreviewSaveService
  logs: string[]
} {
  const { logger, logs } = loggerOf()
  const service: SceneExportApplicationService = { exportSavedScene }
  return {
    logs,
    exportSavedScene,
    latestPreviewSave,
    controller: new SceneExportController(service, latestPreviewSave, new IpcExceptionHandler(logger))
  }
}

function systemPathController(
  openDirectory: OpenDirectoryApplicationService['openDirectory']
): { controller: SystemPathController; logs: string[] } {
  const { logger, logs } = loggerOf()
  return {
    logs,
    controller: new SystemPathController({ openDirectory }, new IpcExceptionHandler(logger))
  }
}

describe('单场景导出用户接口', () => {
  it('只注册已保存场景导出通道，并把 Windows 打包不可用原样返回', async () => {
    const { controller: sceneExport, exportSavedScene } = controller()
    const detach = registerSceneExportIpc({
      sceneExport,
      getWindow: () => ({}) as never,
      rendererUrl: 'http://127.0.0.1:5173/'
    })

    expect([...ipc.handlers.keys()]).toEqual(fixedChannels)
    await expect(sceneExport.exportSavedScene(request(), access)).resolves.toEqual({
      code: ErrorCodes.success,
      msg: '场景导出已返回',
      data: unavailable()
    })
    expect(exportSavedScene).toHaveBeenCalledOnce()
    expect(JSON.stringify(await sceneExport.exportSavedScene(request(), access))).not.toMatch(
      /[A-Za-z]:[\\/]|WebGAL\.exe|stageUrl/
    )
    detach()
    expect(ipc.handlers.size).toBe(0)
  })

  it('空白、候选、草稿、路径和命令在调用导出前拒绝', async () => {
    const { controller: sceneExport, exportSavedScene } = controller()
    const saved = request()

    await expect(
      sceneExport.exportSavedScene({ ...saved, projectId: '   ' }, access)
    ).resolves.toMatchObject({
      code: ErrorCodes.invalidRequest
    })
    await expect(
      sceneExport.exportSavedScene({ ...saved, candidateSnapshotId: 'candidate-1' }, access)
    ).resolves.toMatchObject({ code: ErrorCodes.invalidRequest })
    await expect(
      sceneExport.exportSavedScene({ ...saved, draftText: '未保存草稿' }, access)
    ).resolves.toMatchObject({ code: ErrorCodes.invalidRequest })
    await expect(
      sceneExport.exportSavedScene({ ...saved, outputPath: 'D:/secret/WebGAL.exe' }, access)
    ).resolves.toMatchObject({ code: ErrorCodes.invalidRequest })
    await expect(
      sceneExport.exportSavedScene({ ...saved, command: 'electron-builder' }, access)
    ).resolves.toMatchObject({ code: ErrorCodes.invalidRequest })
    await expect(sceneExport.exportSavedScene(saved, denied)).resolves.toMatchObject({
      code: ErrorCodes.forbidden
    })
    expect(exportSavedScene).not.toHaveBeenCalled()
  })

  it('保存未完成和路径异常映射为安全错误，不调用成功产物', async () => {
    const exportSavedScene = vi
      .fn()
      .mockRejectedValueOnce(
        new AppException({
          code: SceneExportErrorCodes.saveNotCommitted,
          msg: '当前场景还没有保存成功，不能导出'
        })
      )
      .mockRejectedValueOnce(
        new AppException({
          code: SceneExportErrorCodes.savedContentMismatch,
          msg: 'D:/secret/game/scene/start.txt 与保存不一致'
        })
      )
      .mockRejectedValueOnce(new Error('stack at D:/secret/WebGAL.exe'))
    const { controller: sceneExport, logs } = controller(exportSavedScene)

    await expect(sceneExport.exportSavedScene(request(), access)).resolves.toEqual({
      code: SceneExportErrorCodes.saveNotCommitted,
      msg: '当前场景还没有保存成功，不能导出'
    })
    const leaked = await sceneExport.exportSavedScene(request(), access)
    expect(leaked).toEqual({
      code: SceneExportErrorCodes.savedContentMismatch,
      msg: '系统异常，操作未完成'
    })
    const unknown = await sceneExport.exportSavedScene(request(), access)
    expect(unknown).toEqual({ code: ErrorCodes.internalError, msg: '系统异常，操作未完成' })
    expect(JSON.stringify([leaked, unknown, logs])).not.toContain('secret')
    expect(JSON.stringify([leaked, unknown])).not.toContain('WebGAL.exe')
  })

  it('客户端只接受安全导出结果，浏览器桥固定返回不支持', async () => {
    const bridge = createDesktopBridge({
      invoke: async (channel, input) => {
        if (channel !== 'scene-export:export-saved-scene')
          return { code: ErrorCodes.invalidRequest, msg: '错误通道' }
        return {
          code: ErrorCodes.success,
          msg: '场景导出已返回',
          data: {
            status: 'succeeded',
            artifact: {
              executableName: 'game.zip',
              directoryName: 'D:/secret/export',
              directoryPath: 'D:/secret/export',
              bytes: 1,
              containsFixedEngine: true,
              entryRelativePath: 'game/scene/start.txt',
              contentBasis: request().contentBasis,
              versionReference: request().versionReference
            }
          },
          input
        }
      },
      subscribe: () => () => undefined
    })
    const client = new SceneExportClientImpl(bridge)
    const rejected = await client.exportSavedScene(request())
    expect(rejected.code).toBe(ErrorCodes.communicationFailed)
    expect(JSON.stringify(rejected)).not.toContain('secret')
    expect(JSON.stringify(rejected)).not.toContain('game.zip')

    vi.stubGlobal('window', { location: { search: '' } })
    vi.stubGlobal('document', {
      createElement: () => ({ setAttribute: () => undefined, hidden: false }),
      body: { append: () => undefined }
    })
    const browser = createBrowserDesktopBridge()
    await expect(browser.exportSavedScene(request())).resolves.toMatchObject({
      code: ErrorCodes.forbidden,
      msg: '当前环境不支持场景导出'
    })
  })

  it('客户端接受带绝对产物目录路径的成功结果', async () => {
    const artifact = {
      executableName: 'WebGAL.exe' as const,
      directoryName: 'scene-0123456789abcdef',
      directoryPath: 'D:/user/.opengalgame/exports/scene-0123456789abcdef',
      bytes: 12,
      containsFixedEngine: true as const,
      entryRelativePath: 'game/scene/start.txt',
      contentBasis: request().contentBasis,
      versionReference: request().versionReference
    }
    const bridge = createDesktopBridge({
      invoke: async (channel) => {
        if (channel !== 'scene-export:export-saved-scene')
          return { code: ErrorCodes.invalidRequest, msg: '错误通道' }
        return {
          code: ErrorCodes.success,
          msg: '场景导出已返回',
          data: { status: 'succeeded', artifact }
        }
      },
      subscribe: () => () => undefined
    })
    const client = new SceneExportClientImpl(bridge)
    await expect(client.exportSavedScene(request())).resolves.toEqual({
      code: ErrorCodes.success,
      msg: '场景导出已返回',
      data: { status: 'succeeded', artifact }
    })
  })
})

describe('最近预览保存版本查询用户接口', () => {
  it('注册查询通道并原样返回最近版本，非法输入在调用前拒绝', async () => {
    const readLatestPreviewSave = vi.fn(async () => previewVersion())
    const { controller: sceneExport } = controller(vi.fn(async () => unavailable()), {
      readLatestPreviewSave
    })
    const detach = registerSceneExportIpc({
      sceneExport,
      getWindow: () => ({}) as never,
      rendererUrl: 'http://127.0.0.1:5173/'
    })

    expect([...ipc.handlers.keys()]).toEqual(fixedChannels)
    await expect(
      sceneExport.readLatestPreviewSave({ projectId: 'project-1', sceneId: 'scene-1' }, access)
    ).resolves.toEqual({
      code: ErrorCodes.success,
      msg: '最近一次预览保存已返回',
      data: previewVersion()
    })
    expect(readLatestPreviewSave).toHaveBeenCalledOnce()

    await expect(sceneExport.readLatestPreviewSave(null, access)).resolves.toMatchObject({
      code: ErrorCodes.invalidRequest
    })
    await expect(
      sceneExport.readLatestPreviewSave({ projectId: 'project-1' }, access)
    ).resolves.toMatchObject({ code: ErrorCodes.invalidRequest })
    await expect(
      sceneExport.readLatestPreviewSave(
        { projectId: 'project-1', sceneId: 'scene-1', extra: true },
        access
      )
    ).resolves.toMatchObject({ code: ErrorCodes.invalidRequest })
    await expect(
      sceneExport.readLatestPreviewSave({ projectId: '   ', sceneId: 'scene-1' }, access)
    ).resolves.toMatchObject({ code: ErrorCodes.invalidRequest })
    await expect(
      sceneExport.readLatestPreviewSave({ projectId: 'project-1', sceneId: 'scene-1' }, denied)
    ).resolves.toMatchObject({ code: ErrorCodes.forbidden })
    expect(readLatestPreviewSave).toHaveBeenCalledOnce()
    detach()
    expect(ipc.handlers.size).toBe(0)
  })

  it('没有已结算版本时原样返回 null', async () => {
    const { controller: sceneExport, latestPreviewSave } = controller()
    await expect(
      sceneExport.readLatestPreviewSave({ projectId: 'project-1', sceneId: 'scene-1' }, access)
    ).resolves.toEqual({
      code: ErrorCodes.success,
      msg: '最近一次预览保存已返回',
      data: null
    })
    expect(latestPreviewSave.readLatestPreviewSave).toHaveBeenCalledOnce()
  })

  it('客户端只接受安全的最近版本结果，浏览器桥固定返回不支持', async () => {
    const bridge = createDesktopBridge({
      invoke: async (channel) => {
        if (channel !== 'scene-export:read-latest-preview-save')
          return { code: ErrorCodes.invalidRequest, msg: '错误通道' }
        return {
          code: ErrorCodes.success,
          msg: '最近一次预览保存已返回',
          data: previewVersion()
        }
      },
      subscribe: () => () => undefined
    })
    const client = new SceneExportClientImpl(bridge)
    await expect(
      client.readLatestPreviewSave({ projectId: 'project-1', sceneId: 'scene-1' })
    ).resolves.toEqual({
      code: ErrorCodes.success,
      msg: '最近一次预览保存已返回',
      data: previewVersion()
    })

    const malformed = createDesktopBridge({
      invoke: async () => ({
        code: ErrorCodes.success,
        msg: '最近一次预览保存已返回',
        data: { requestId: 'request-1', revisionDigest: 'not-a-digest', contentBasis: request().contentBasis }
      }),
      subscribe: () => () => undefined
    })
    const rejected = await new SceneExportClientImpl(malformed).readLatestPreviewSave({
      projectId: 'project-1',
      sceneId: 'scene-1'
    })
    expect(rejected.code).toBe(ErrorCodes.communicationFailed)

    vi.stubGlobal('window', { location: { search: '' } })
    vi.stubGlobal('document', {
      createElement: () => ({ setAttribute: () => undefined, hidden: false }),
      body: { append: () => undefined }
    })
    const browser = createBrowserDesktopBridge()
    await expect(
      browser.readLatestPreviewSave({ projectId: 'project-1', sceneId: 'scene-1' })
    ).resolves.toMatchObject({
      code: ErrorCodes.forbidden,
      msg: '当前环境不支持读取场景保存版本'
    })
  })
})

describe('打开本机目录用户接口', () => {
  it('只注册打开目录通道，并把校验失败原样返回', async () => {
    const openDirectory = vi.fn(async () => undefined)
    const { controller: systemPath } = systemPathController(openDirectory)
    const detach = registerSystemPathIpc({
      systemPath,
      getWindow: () => ({}) as never,
      rendererUrl: 'http://127.0.0.1:5173/'
    })

    expect([...ipc.handlers.keys()]).toEqual(['system:open-directory'])
    await expect(
      systemPath.openDirectory({ path: 'D:/project/exports/scene-1' }, access)
    ).resolves.toEqual({
      code: ErrorCodes.success,
      msg: '目录已交给系统打开',
      data: null
    })
    expect(openDirectory).toHaveBeenCalledWith({ path: 'D:/project/exports/scene-1' })

    await expect(systemPath.openDirectory(null, access)).resolves.toMatchObject({
      code: ErrorCodes.invalidRequest
    })
    await expect(systemPath.openDirectory({}, access)).resolves.toMatchObject({
      code: ErrorCodes.invalidRequest
    })
    await expect(systemPath.openDirectory({ path: '   ' }, access)).resolves.toMatchObject({
      code: ErrorCodes.invalidRequest
    })
    await expect(
      systemPath.openDirectory({ path: 'D:/project/exports/scene-1', args: ['/c'] }, access)
    ).resolves.toMatchObject({ code: ErrorCodes.invalidRequest })
    await expect(
      systemPath.openDirectory({ path: 'D:/project/exports/scene-1' }, denied)
    ).resolves.toMatchObject({ code: ErrorCodes.forbidden })
    expect(openDirectory).toHaveBeenCalledOnce()

    openDirectory.mockRejectedValueOnce(
      new AppException({
        code: SystemPathErrorCodes.pathRejected,
        msg: '只能打开本机已有的目录'
      })
    )
    await expect(
      systemPath.openDirectory({ path: 'D:/project/exports/missing' }, access)
    ).resolves.toEqual({
      code: SystemPathErrorCodes.pathRejected,
      msg: '只能打开本机已有的目录'
    })
    detach()
    expect(ipc.handlers.size).toBe(0)
  })

  it('客户端只接受安全结果，浏览器桥固定返回不支持', async () => {
    const bridge = createDesktopBridge({
      invoke: async (channel) => {
        if (channel !== 'system:open-directory')
          return { code: ErrorCodes.invalidRequest, msg: '错误通道' }
        return { code: ErrorCodes.success, msg: '目录已交给系统打开', data: null }
      },
      subscribe: () => () => undefined
    })
    const client = new SceneExportClientImpl(bridge)
    await expect(
      client.openDirectory({ path: 'D:/project/exports/scene-1' })
    ).resolves.toEqual({ code: ErrorCodes.success, msg: '目录已交给系统打开', data: null })

    const malformed = createDesktopBridge({
      invoke: async () => ({
        code: ErrorCodes.success,
        msg: '目录已交给系统打开',
        data: { path: 'D:/secret' }
      }),
      subscribe: () => () => undefined
    })
    const rejected = await new SceneExportClientImpl(malformed).openDirectory({
      path: 'D:/project/exports/scene-1'
    })
    expect(rejected.code).toBe(ErrorCodes.communicationFailed)
    expect(JSON.stringify(rejected)).not.toContain('secret')

    vi.stubGlobal('window', { location: { search: '' } })
    vi.stubGlobal('document', {
      createElement: () => ({ setAttribute: () => undefined, hidden: false }),
      body: { append: () => undefined }
    })
    const browser = createBrowserDesktopBridge()
    await expect(
      browser.openDirectory({ path: 'D:/project/exports/scene-1' })
    ).resolves.toMatchObject({
      code: ErrorCodes.forbidden,
      msg: '当前环境不能打开本机目录'
    })
  })
})
