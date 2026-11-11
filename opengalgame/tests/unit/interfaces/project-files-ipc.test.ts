import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import type { ProjectFilesApplicationService } from '@application/project-files/services/ProjectFilesApplicationService'
import type { ProjectFilesInspectionVO } from '@application/project-files/vo/ProjectFilesInspectionVO'
import type {
  ProjectInputSourceSummaryVO,
  ProjectInputSourcesSnapshotVO
} from '@application/project-files/vo/ProjectInputSourceVO'

import { createBrowserDesktopBridge } from '@bootstrap/browser/BrowserDesktopBridge'
import type { AjaxResult } from '@common/contracts/AjaxResult'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import type { LogContext } from '@common/logging/LogContext'
import type { LoggerGateway } from '@common/logging/LoggerGateway'
import { ProjectFileErrorCodes } from '@domain/project-files/errors/ProjectFileErrorCodes'
import { ProjectFilesClientImpl } from '@interfaces/project-files/client/ProjectFilesClientImpl'
import { SceneCanvasClientImpl } from '@interfaces/scene-canvas/client/SceneCanvasClientImpl'
import { createIpcRequestAccess } from '@interfaces/ipc/createIpcRequestAccess'
import { IpcExceptionHandler } from '@interfaces/ipc/errors/IpcExceptionHandler'
import { ProjectFilesController } from '@interfaces/project-files/ipc/ProjectFilesController'

const rendererUrl = 'http://127.0.0.1:5173/'
const trustedAccess = { trusted: true, requestId: 'req-trusted' }

interface LogCall {
  event: string
  context?: LogContext
}

function createLogger(): { logger: LoggerGateway; calls: LogCall[] } {
  const calls: LogCall[] = []
  const record = (event: string, context?: LogContext): void => {
    calls.push({ event, context })
  }
  return {
    calls,
    logger: { debug: record, info: record, warn: record, error: record }
  }
}

function createHarness(): {
  projectFiles: {
    [K in keyof ProjectFilesApplicationService]: ReturnType<typeof vi.fn>
  }
  controller: ProjectFilesController
  calls: LogCall[]
} {
  const { logger, calls } = createLogger()
  const projectFiles = {
    inspectProjectFiles: vi.fn(),
    listProjectInputSources: vi.fn(),
    readProjectInputSources: vi.fn(),
    readProjectMedia: vi.fn(),
    importProjectFiles: vi.fn(),
    openProjectFile: vi.fn(),
    renameProjectFile: vi.fn(),
    deleteProjectFile: vi.fn(),
    updateProjectTextFileBody: vi.fn()
  }
  return {
    projectFiles,
    calls,
    controller: new ProjectFilesController(projectFiles, new IpcExceptionHandler(logger), {
      chooseProjectFiles: vi.fn(async () => null)
    })
  }
}

function fakeWindow(
  url = rendererUrl,
  destroyed = false
): {
  window: BrowserWindow
  sender: object
  mainFrame: { url: string }
} {
  const mainFrame = { url }
  const sender = { mainFrame }
  const window = {
    isDestroyed: () => destroyed,
    webContents: sender
  } as unknown as BrowserWindow
  return { window, sender, mainFrame }
}

function fakeEvent(sender: object, frame: { url: string }): IpcMainInvokeEvent {
  return { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent
}

const inspection: ProjectFilesInspectionVO = {
  projectId: 'project-1',
  inputSourceFormatSupported: false,
  canvasArrangementFormatSupported: true,
  diagnostics: [
    { objectId: 'source-1', kind: 'missing' },
    { objectId: 'source-2', kind: 'damaged' },
    { objectId: 'source-1', kind: 'duplicateIdentity' },
    { objectId: 'card-1', kind: 'brokenReference' }
  ]
}

const snapshot: ProjectInputSourcesSnapshotVO = {
  projectId: 'project-1',
  readVersion: 'read-v1',
  sources: [
    {
      sourceId: 'doc-1',
      version: 'doc-v',
      contentKind: 'text',
      textKind: 'document',
      title: '标题',
      body: '正文',
      topics: ['雨'],
      importInfo: { format: 'markdown' }
    },
    {
      sourceId: 'image-1',
      version: 'image-v',
      contentKind: 'image',
      name: '工坊.png',
      fileId: 'file-image',
      description: '夜色'
    },
    {
      sourceId: 'audio-1',
      version: 'audio-v',
      contentKind: 'audio',
      name: '夜色.wav',
      fileId: 'file-audio',
      description: '循环'
    },
    {
      sourceId: 'video-1',
      version: 'video-v',
      contentKind: 'video',
      name: '片头.mp4',
      fileId: 'file-video',
      description: '片头'
    }
  ]
}

const summaries: readonly ProjectInputSourceSummaryVO[] = [
  {
    sourceId: 'doc-1',
    name: '标题',
    readable: true,
    parentFolderId: null,
    contentKind: 'text',
    textKind: 'document'
  },
  {
    sourceId: 'image-1',
    name: '工坊.png',
    readable: true,
    parentFolderId: null,
    contentKind: 'image'
  },
  {
    sourceId: 'audio-1',
    name: '夜色.wav',
    readable: true,
    parentFolderId: null,
    contentKind: 'audio'
  },
  {
    sourceId: 'video-1',
    name: '片头.mp4',
    readable: true,
    parentFolderId: null,
    contentKind: 'video'
  }
]
const catalog = {
  projectId: 'project-1',
  catalogVersion: 'catalog-v1',
  folders: [],
  sources: summaries
}

describe('工程文件请求来源', () => {
  it('非当前主框架、已跳转文档、已销毁或缺失窗口都不可信，且不沿用上一次窗口', () => {
    const current = fakeWindow()
    let active: BrowserWindow | null = current.window
    const readAccess = createIpcRequestAccess({ getWindow: () => active, rendererUrl })
    const trusted = readAccess(fakeEvent(current.sender, current.mainFrame))
    expect(trusted.trusted).toBe(true)
    expect(trusted.requestId.length).toBeGreaterThan(0)

    const subframe = readAccess(fakeEvent(current.sender, { url: rendererUrl }))
    expect(subframe.trusted).toBe(false)
    current.mainFrame.url = 'http://127.0.0.1:5173/other'
    expect(readAccess(fakeEvent(current.sender, current.mainFrame)).trusted).toBe(false)
    current.mainFrame.url = `${rendererUrl}#/home`
    expect(readAccess(fakeEvent(current.sender, current.mainFrame)).trusted).toBe(true)

    const destroyed = fakeWindow(rendererUrl, true)
    active = destroyed.window
    expect(readAccess(fakeEvent(destroyed.sender, destroyed.mainFrame)).trusted).toBe(false)
    active = null
    expect(readAccess(fakeEvent(current.sender, current.mainFrame)).trusted).toBe(false)
    expect(readAccess(fakeEvent(current.sender, current.mainFrame)).requestId).not.toBe(
      trusted.requestId
    )
  })

  it('来源事实不能由请求体伪造，不可信调用不会进入应用用例', async () => {
    const { controller, projectFiles } = createHarness()
    const blocked = createIpcRequestAccess({
      getWindow: () => null,
      rendererUrl
    })({} as IpcMainInvokeEvent)
    const result = await controller.inspectProjectFiles(
      { projectId: 'project-1', trusted: true, path: 'C:\\secret\\project' },
      blocked
    )

    expect(blocked.trusted).toBe(false)
    expect(result).toEqual({ code: ErrorCodes.forbidden, msg: '请求来源或资源访问未获授权' })
    expect(projectFiles.inspectProjectFiles).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toContain('secret')
  })
})

describe('工程文件请求协议', () => {
  it('缺失、错类型和路径字段被拒绝，空白与重复身份原样交给应用用例', async () => {
    const { controller, projectFiles } = createHarness()
    const readRequest = { projectId: '  p  ', sourceIds: [' a ', ' a ', ''] }

    expect(
      await controller.inspectProjectFiles({ sceneId: 'scene-1' }, trustedAccess)
    ).toMatchObject({ code: ErrorCodes.invalidRequest })
    expect(await controller.listProjectInputSources({ projectId: 1 }, trustedAccess)).toMatchObject(
      { code: ErrorCodes.invalidRequest }
    )
    expect(
      await controller.readProjectInputSources(
        { ...readRequest, directory: 'C:/secret' },
        trustedAccess
      )
    ).toMatchObject({ code: ErrorCodes.invalidRequest })
    expect(projectFiles.inspectProjectFiles).not.toHaveBeenCalled()
    expect(projectFiles.listProjectInputSources).not.toHaveBeenCalled()
    expect(projectFiles.readProjectInputSources).not.toHaveBeenCalled()

    projectFiles.readProjectInputSources.mockResolvedValueOnce(snapshot)
    await controller.readProjectInputSources(readRequest, trustedAccess)
    expect(projectFiles.readProjectInputSources).toHaveBeenCalledWith(readRequest)

    const updateRequest = {
      projectId: 'project-1',
      sourceId: 'doc-1',
      expectedSourceVersion: 'doc-v',
      content: { textKind: 'document', body: '新正文' }
    }
    expect(
      await controller.updateProjectTextFileBody(
        { ...updateRequest, directory: 'C:/secret' },
        trustedAccess
      )
    ).toMatchObject({ code: ErrorCodes.invalidRequest })
    expect(
      await controller.updateProjectTextFileBody(
        { ...updateRequest, content: { textKind: 'document' } },
        trustedAccess
      )
    ).toMatchObject({ code: ErrorCodes.invalidRequest })
    expect(
      await controller.updateProjectTextFileBody(
        { ...updateRequest, content: { textKind: 'plainText', body: '' } },
        trustedAccess
      )
    ).toMatchObject({ code: ErrorCodes.invalidRequest })
    expect(
      await controller.updateProjectTextFileBody(
        { ...updateRequest, expectedSourceVersion: 1 },
        trustedAccess
      )
    ).toMatchObject({ code: ErrorCodes.invalidRequest })
    expect(projectFiles.updateProjectTextFileBody).not.toHaveBeenCalled()

    projectFiles.updateProjectTextFileBody.mockResolvedValueOnce(snapshot.sources[0])
    expect(await controller.updateProjectTextFileBody(updateRequest, trustedAccess)).toEqual({
      code: ErrorCodes.success,
      msg: '正文已保存',
      data: snapshot.sources[0]
    })
    expect(projectFiles.updateProjectTextFileBody).toHaveBeenCalledWith(updateRequest)
  })
})

describe('工程文件通道结果', () => {
  it('有诊断的检查仍成功，扫描失败、不可读摘要和成功空列表彼此不同', async () => {
    const { controller, projectFiles, calls } = createHarness()
    projectFiles.inspectProjectFiles.mockResolvedValueOnce(inspection)
    expect(await controller.inspectProjectFiles({ projectId: 'project-1' }, trustedAccess)).toEqual(
      {
        code: ErrorCodes.success,
        msg: '工程文件检查完成',
        data: inspection
      }
    )

    projectFiles.listProjectInputSources.mockResolvedValueOnce(summaries)
    expect(
      await controller.listProjectInputSources({ projectId: 'project-1' }, trustedAccess)
    ).toEqual({
      code: ErrorCodes.success,
      msg: '输入来源扫描完成',
      data: summaries
    })

    projectFiles.listProjectInputSources.mockResolvedValueOnce([])
    expect(
      await controller.listProjectInputSources({ projectId: 'project-1' }, trustedAccess)
    ).toEqual({
      code: ErrorCodes.success,
      msg: '输入来源扫描完成',
      data: []
    })

    projectFiles.listProjectInputSources.mockRejectedValueOnce(
      new AppException({ code: ProjectFileErrorCodes.readFailed, msg: '输入来源无法扫描' })
    )
    const failed = await controller.listProjectInputSources(
      { projectId: 'project-1' },
      trustedAccess
    )
    expect(failed).toEqual({ code: ProjectFileErrorCodes.readFailed, msg: '输入来源无法扫描' })
    expect(failed).not.toHaveProperty('data')
    expect(calls.map((call) => call.event)).toEqual(['请求执行失败'])
  })

  it('批量读取失败不带部分数据；没有编排是成功 null，损坏和归属错误不是 null', async () => {
    const { controller, projectFiles } = createHarness()
    projectFiles.readProjectInputSources.mockRejectedValueOnce(
      new AppException({ code: ProjectFileErrorCodes.contentDamaged, msg: '来源内容已损坏' })
    )
    const failed = await controller.readProjectInputSources(
      { projectId: 'project-1', sourceIds: ['doc-1', 'missing'] },
      trustedAccess
    )
    expect(failed).toEqual({ code: ProjectFileErrorCodes.contentDamaged, msg: '来源内容已损坏' })
    expect(failed).not.toHaveProperty('data')
  })
})

describe('工程文件错误出口', () => {
  it('技术异常只在统一出口记录一次，响应和日志都不含路径或请求内容', async () => {
    const { controller, projectFiles, calls } = createHarness()
    const error = new Error('EPERM C:\\Users\\secret\\project\\inputs\\body.txt')
    error.stack = 'Error: EPERM C:\\Users\\secret\\project\\inputs\\body.txt\n    at readFile'
    projectFiles.readProjectInputSources.mockRejectedValueOnce(error)
    const result = await controller.readProjectInputSources(
      { projectId: 'project-1', sourceIds: ['source-secret-正文'] },
      { trusted: true, requestId: 'req-1' }
    )

    expect(result).toEqual({ code: ErrorCodes.internalError, msg: '系统异常，操作未完成' })
    expect(calls).toEqual([
      {
        event: '请求执行失败',
        context: { requestId: 'req-1', errorCode: ErrorCodes.internalError }
      }
    ])
    const revealed = JSON.stringify({ result, calls })
    expect(revealed).not.toContain('secret')
    expect(revealed).not.toContain('body.txt')
    expect(revealed).not.toContain('readFile')
    expect(revealed).not.toContain('source-secret')
  })
})

describe('工程文件客户端响应', () => {
  function createClient(invoke: (channel: string) => Promise<unknown>): ProjectFilesClientImpl {
    return new ProjectFilesClientImpl({
      inspectProjectFiles: () => invoke('inspect'),
      listProjectInputSources: () => invoke('list'),
      readProjectInputSources: () => invoke('read'),
      readProjectMedia: () => invoke('media')
    } as never)
  }

  it('保留文档、素材和字段卡片编排', async () => {
    const payloads = new Map<string, unknown>([
      ['inspect', { code: ErrorCodes.success, msg: 'ok', data: inspection }],
      ['list', { code: ErrorCodes.success, msg: 'ok', data: catalog }],
      ['read', { code: ErrorCodes.success, msg: 'ok', data: snapshot }]
    ])
    const client = createClient(async (channel) => payloads.get(channel))

    expect(await client.inspectProjectFiles({ projectId: 'project-1' })).toEqual(
      payloads.get('inspect')
    )
    expect(await client.listProjectInputSources({ projectId: 'project-1' })).toEqual(
      payloads.get('list')
    )
    expect(
      await client.readProjectInputSources({ projectId: 'project-1', sourceIds: ['doc-1'] })
    ).toEqual(payloads.get('read'))
  })

  it('保存正文结果保留单个来源，夹带路径或错误内容被拒绝', async () => {
    const request = {
      projectId: 'project-1',
      sourceId: 'doc-1',
      expectedSourceVersion: 'doc-v',
      content: { textKind: 'document' as const, body: '新正文' }
    }
    const payload = {
      code: ErrorCodes.success,
      msg: '正文已保存',
      data: { ...snapshot.sources[0], body: '新正文' }
    }
    const client = new ProjectFilesClientImpl({
      updateProjectTextFileBody: async () => payload
    } as never)
    expect(await client.updateProjectTextFileBody(request)).toEqual(payload)

    const rejected = new ProjectFilesClientImpl({
      updateProjectTextFileBody: async () => ({
        code: ErrorCodes.success,
        msg: '正文已保存',
        data: { ...snapshot.sources[0], absolutePath: 'C:/secret/正文.md' }
      })
    } as never)
    expect(await rejected.updateProjectTextFileBody(request)).toEqual({
      code: ErrorCodes.communicationFailed,
      msg: '与主进程通信失败，操作结果待确认'
    })
  })

  it('保留媒体字节，拒绝把字节改成文本或夹带路径', async () => {
    const bytes = Uint8Array.from([137, 80, 78, 71])
    const media = {
      code: ErrorCodes.success,
      msg: '媒体读取完成',
      data: {
        sourceId: 'img-1',
        contentKind: 'image',
        fileName: 'roof.png',
        mediaType: 'image/png',
        bytes
      }
    }
    const client = createClient(async (channel) => (channel === 'media' ? media : undefined))
    expect(await client.readProjectMedia({ projectId: 'project-1', sourceId: 'img-1' })).toEqual(
      media
    )
    const rejected = createClient(async () => ({
      code: ErrorCodes.success,
      msg: '媒体读取完成',
      data: { ...media.data, bytes: 'not-bytes', absolutePath: 'C:/secret.png' }
    }))
    expect(
      await rejected.readProjectMedia({ projectId: 'project-1', sourceId: 'img-1' })
    ).toMatchObject({ code: ErrorCodes.communicationFailed })
  })

  it('渲染页只放宽本地和受控媒体来源', () => {
    const html = readFileSync(join(process.cwd(), 'src/bootstrap/index.html'), 'utf8')
    const policy = html.match(/content="([^"]+)"/u)?.[1] ?? ''
    expect(policy).toContain("img-src 'self' data: blob:")
    expect(policy).toContain("media-src 'self' data: blob:")
    expect(policy).toContain("connect-src 'self' ws://127.0.0.1:5173 http://127.0.0.1:5173")
    expect(policy).not.toContain('*')
    expect(policy).not.toContain('https:')
  })

  it('缺数据、错误联合、动画特效来源、失败夹带数据和传输中断都不是有效读取', async () => {
    const rejected: unknown[] = [
      { code: ErrorCodes.success, msg: 'ok' },
      { code: ErrorCodes.success, msg: 'ok', data: null },
      {
        code: ErrorCodes.success,
        msg: 'ok',
        data: {
          projectId: 'project-1',
          readVersion: 'v',
          sources: [
            {
              sourceId: 'prompt-1',
              version: 'v',
              contentKind: 'text',
              textKind: 'document',
              name: '互换',
              body: '正文'
            }
          ]
        }
      },
      {
        code: ErrorCodes.success,
        msg: 'ok',
        data: {
          projectId: 'project-1',
          readVersion: 'v',
          sources: [
            {
              sourceId: 'effect-1',
              version: 'v',
              contentKind: 'effect',
              name: '转场'
            }
          ]
        }
      },
      {
        code: ErrorCodes.success,
        msg: 'ok',
        data: {
          projectId: 'project-1',
          readVersion: 'v',
          sources: [
            {
              sourceId: 'anim-1',
              version: 'v',
              contentKind: 'animation',
              name: '动画'
            }
          ]
        }
      },
      {
        code: ProjectFileErrorCodes.contentDamaged,
        msg: '来源内容已损坏',
        data: { projectId: 'project-1', readVersion: 'old', sources: snapshot.sources.slice(0, 1) }
      },
      {
        code: ErrorCodes.success,
        msg: 'ok',
        data: {
          ...snapshot,
          sources: snapshot.sources.map((source) =>
            source.contentKind === 'image' ? { ...source, path: 'C:\\secret\\bg.png' } : source
          )
        }
      }
    ]
    const read = vi.fn()
    const client = new ProjectFilesClientImpl({ readProjectInputSources: read } as never)
    for (const payload of rejected) {
      read.mockResolvedValueOnce(payload)
      const result = await client.readProjectInputSources({
        projectId: 'project-1',
        sourceIds: ['doc-1']
      })
      expect(result).toEqual({
        code: ErrorCodes.communicationFailed,
        msg: '与主进程通信失败，操作结果待确认'
      })
      expect(JSON.stringify(result)).not.toContain('secret')
      expect(result).not.toHaveProperty('data')
    }

    read.mockRejectedValueOnce(new Error('ipc offline C:\\secret\\pipe'))
    const offline = await client.readProjectInputSources({
      projectId: 'project-1',
      sourceIds: ['doc-1']
    })
    expect(offline).toEqual({
      code: ErrorCodes.communicationFailed,
      msg: '与主进程通信失败，操作结果待确认'
    })
    expect(JSON.stringify(offline)).not.toContain('secret')
  })

  it('结构合格的业务失败原样返回，不改写成空列表或 null', async () => {
    const failure: AjaxResult<never> = {
      code: ProjectFileErrorCodes.readFailed,
      msg: '输入来源无法扫描'
    }
    const client = new ProjectFilesClientImpl({
      listProjectInputSources: async () => failure
    } as never)
    expect(await client.listProjectInputSources({ projectId: 'project-1' })).toEqual(failure)
  })
})

describe('浏览器工程文件桥', () => {
  function stubBrowser(search: string): void {
    vi.stubGlobal('window', { location: { search } })
    vi.stubGlobal('document', {
      createElement: () => ({ setAttribute: vi.fn(), hidden: true }),
      body: { append: vi.fn() }
    })
  }

  it('默认夹具返回来源和只读编排，失败场景不用空列表或 null 冒充成功', async () => {
    stubBrowser('')
    const client = new ProjectFilesClientImpl(createBrowserDesktopBridge())
    const listed = await client.listProjectInputSources({ projectId: 'project-1' })
    expect(listed.code).toBe(ErrorCodes.success)
    expect(listed.data?.sources.length).toBeGreaterThan(0)
    const arrangement = await new SceneCanvasClientImpl(
      createBrowserDesktopBridge()
    ).readSceneCanvasArrangement({
      projectId: 'project-1',
      sceneId: 'scene-1',
      canvasId: 'canvas-1'
    })
    expect(arrangement.code).toBe(ErrorCodes.success)
    expect(new Set(arrangement.data?.cards.map((card) => card.kind))).toEqual(
      new Set(['document', 'image', 'audio', 'video', 'prompt', 'animation', 'effect'])
    )
    expect(arrangement.data?.relations).toHaveLength(2)
    expect(arrangement.data?.relations[0]).toMatchObject({
      specificName: '同一场景',
      recordCardId: 'card-doc'
    })
    expect(arrangement.data?.relations[1]).toMatchObject({ specificName: '', recordCardId: null })
    vi.unstubAllGlobals()

    stubBrowser('?workbench=fail')
    const failed = new ProjectFilesClientImpl(createBrowserDesktopBridge())
    const expected = { code: ErrorCodes.communicationFailed, msg: '当前环境不能读取工程文件' }
    expect(await failed.inspectProjectFiles({ projectId: 'project-1' })).toEqual(expected)
    expect(await failed.listProjectInputSources({ projectId: 'project-1' })).toEqual(expected)
    expect(
      await new SceneCanvasClientImpl(createBrowserDesktopBridge()).readSceneCanvasArrangement({
        projectId: 'project-1',
        sceneId: 'scene-1',
        canvasId: 'canvas-1'
      })
    ).toEqual(expected)
    vi.unstubAllGlobals()

    stubBrowser('?workbench=empty')
    const empty = new ProjectFilesClientImpl(createBrowserDesktopBridge())
    expect(await empty.listProjectInputSources({ projectId: 'project-empty' })).toMatchObject({
      code: ErrorCodes.success,
      data: { projectId: 'project-empty', catalogVersion: 'empty', folders: [], sources: [] }
    })
    expect(
      await new SceneCanvasClientImpl(createBrowserDesktopBridge()).readSceneCanvasArrangement({
        projectId: 'project-1',
        sceneId: 'scene-1',
        canvasId: 'canvas-1'
      })
    ).toMatchObject({ code: ErrorCodes.success, data: null })
    vi.unstubAllGlobals()

    stubBrowser('?workbench=damaged')
    const broken = await new SceneCanvasClientImpl(
      createBrowserDesktopBridge()
    ).readSceneCanvasArrangement({
      projectId: 'project-1',
      sceneId: 'scene-1',
      canvasId: 'canvas-1'
    })
    expect(broken).toEqual({ code: 4416, msg: '编排内容损坏' })
    vi.unstubAllGlobals()
  })
})

describe('工程文件操作通道', () => {
  it('空导入和多余路径被拒绝，取消选择不调用导入', async () => {
    const { logger } = createLogger()
    const projectFiles = {
      inspectProjectFiles: vi.fn(),
      listProjectInputSources: vi.fn(),
      readProjectInputSources: vi.fn(),
      readProjectMedia: vi.fn(),
      importProjectFiles: vi.fn(),
      openProjectFile: vi.fn(),
      renameProjectFile: vi.fn(),
      deleteProjectFile: vi.fn(),
      updateProjectTextFileBody: vi.fn()
    }
    const controller = new ProjectFilesController(projectFiles, new IpcExceptionHandler(logger), {
      chooseProjectFiles: vi.fn(async () => null)
    })
    expect(
      await controller.importProjectFiles(
        { projectId: 'project-1', localFilePaths: [] },
        trustedAccess
      )
    ).toMatchObject({ code: ErrorCodes.invalidRequest })
    expect(
      await controller.importProjectFiles(
        { projectId: 'project-1', localFilePaths: ['C:/a.png'], directory: 'C:/secret' },
        trustedAccess
      )
    ).toMatchObject({ code: ErrorCodes.invalidRequest })
    expect(projectFiles.importProjectFiles).not.toHaveBeenCalled()
    expect(await controller.chooseProjectFiles({}, trustedAccess)).toEqual({
      code: ErrorCodes.success,
      msg: '文件选择完成',
      data: null
    })
    expect(projectFiles.importProjectFiles).not.toHaveBeenCalled()

    projectFiles.openProjectFile.mockResolvedValueOnce(undefined)
    expect(
      await controller.openProjectFile({ projectId: 'project-1', sourceId: 'src-1' }, trustedAccess)
    ).toEqual({ code: ErrorCodes.success, msg: '已请求打开文件', data: null })

    expect(
      await controller.readProjectMedia(
        { projectId: 'project-1', sourceId: 'img-1', path: 'C:/secret.png' },
        trustedAccess
      )
    ).toMatchObject({ code: ErrorCodes.invalidRequest })
    expect(projectFiles.readProjectMedia).not.toHaveBeenCalled()
    const bytes = Uint8Array.from([1, 2, 3, 4])
    projectFiles.readProjectMedia.mockResolvedValueOnce({
      sourceId: 'img-1',
      contentKind: 'image',
      fileName: 'roof.png',
      mediaType: 'image/png',
      bytes
    })
    expect(
      await controller.readProjectMedia(
        { projectId: 'project-1', sourceId: 'img-1' },
        trustedAccess
      )
    ).toEqual({
      code: ErrorCodes.success,
      msg: '媒体读取完成',
      data: {
        sourceId: 'img-1',
        contentKind: 'image',
        fileName: 'roof.png',
        mediaType: 'image/png',
        bytes
      }
    })
  })

  it('浏览器桥不把文件操作伪装成成功', async () => {
    vi.stubGlobal('window', { location: { search: '' } })
    vi.stubGlobal('document', {
      createElement: () => {
        const listeners = new Map<string, () => void>()
        return {
          setAttribute: vi.fn(),
          hidden: true,
          files: [],
          value: '',
          addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
          removeEventListener: (type: string) => listeners.delete(type),
          click: () => listeners.get('cancel')?.()
        }
      },
      body: { append: vi.fn() }
    })
    const client = new ProjectFilesClientImpl(createBrowserDesktopBridge())
    expect(await client.chooseProjectFiles()).toEqual({
      code: ErrorCodes.success,
      msg: '已取消选择',
      data: null
    })
    const unavailable = { code: ErrorCodes.forbidden, msg: '当前环境不能操作工程文件' }
    expect(
      await client.importProjectFiles({ projectId: 'project-1', localFilePaths: ['C:/a.png'] })
    ).not.toMatchObject({ code: ErrorCodes.success })
    expect(await client.openProjectFile({ projectId: 'project-1', sourceId: 'src-1' })).toEqual(
      unavailable
    )
    expect(await client.deleteProjectFile({ projectId: 'project-1', sourceId: 'src-1' })).toEqual(
      unavailable
    )
    expect(await client.readProjectMedia({ projectId: 'project-1', sourceId: 'img-1' })).toEqual(
      unavailable
    )
    expect(
      await client.updateProjectTextFileBody({
        projectId: 'project-1',
        sourceId: 'doc-1',
        expectedSourceVersion: 'doc-v',
        content: { textKind: 'document', body: '新正文' }
      })
    ).toEqual(unavailable)
    vi.unstubAllGlobals()
  })
})
