import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ProjectVersioningApplicationServiceImpl } from '@application/project-versioning/services/impl/ProjectVersioningApplicationServiceImpl'
import { SceneExportApplicationServiceImpl } from '@application/scene-export/services/impl/SceneExportApplicationServiceImpl'
import type { ScenePreviewSourceGateway } from '@application/scene-preview/ports/ScenePreviewSourceGateway'
import { createScenePreview } from '@bootstrap/scenePreview'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { SceneExportErrorCodes } from '@domain/scene-export/errors/SceneExportErrorCodes'
import { ScenePreviewErrorCodes } from '@domain/scene-preview/errors/ScenePreviewErrorCodes'
import { createProjectVersioningGateways } from '@infrastructure/project-versioning/createProjectVersioningGateways'
import { encodeStorageKey } from '@infrastructure/project-files/projectFilePaths'
import { writeProjectRegistrations } from '@infrastructure/projects/projectRegistrations'
import { LocalSceneExportSourceGateway } from '@infrastructure/scene-export/LocalSceneExportSourceGateway'
import { TerreWindowsScenePackager } from '@infrastructure/scene-export/TerreWindowsScenePackager'
import { IpcExceptionHandler } from '@interfaces/ipc/errors/IpcExceptionHandler'
import { ScenePreviewController } from '@interfaces/scene-preview/ipc/ScenePreviewController'
import { registerScenePreviewIpc } from '@interfaces/scene-preview/ipc/registerScenePreviewIpc'
import { WebgalRuntimeHostImpl } from '@infrastructure/webgal/runtime/WebgalRuntimeHostImpl'
import type { LoggerGateway } from '@common/logging/LoggerGateway'

const require = createRequire(import.meta.url)
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
  }
}))

const roots: string[] = []
const scene = { projectId: 'project-1', sceneId: 'scene-1' }
const script = '小明:原来的正文 -figure=hero.png;\r\n'
const fixedChannels = [
  'scene-preview:availability',
  'scene-preview:open',
  'scene-preview:prepare',
  'scene-preview:draft',
  'scene-preview:save',
  'scene-preview:settlement',
  'scene-preview:select-dialogue',
  'scene-preview:previous-dialogue',
  'scene-preview:next-dialogue',
  'scene-preview:close',
  'scene-preview:subscribe',
  'scene-preview:read-candidate',
  'scene-preview:candidate-event'
]

afterEach(async () => {
  ipc.handlers.clear()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('预览与导出跨层装配', () => {
  it('正式保存只改正文，候选拒绝，真实舞台可准备且 Windows 模板不可用', async () => {
    const world = await registeredScene()
    const previous = process.env.OPENGALGAME_TERRE_WINDOWS_RELEASE
    process.env.OPENGALGAME_TERRE_WINDOWS_RELEASE = join(world.userDirectory, 'missing-terre.zip')
    const trusted = trustedWindow()
    const assembled = await assemble(world, trusted.window)
    expect([...ipc.handlers.keys()].sort()).toEqual([...fixedChannels].sort())

    const event = { sender: trusted.sender, senderFrame: trusted.frame }
    const available = await invoke('scene-preview:availability', event, scene)
    expect(available).toMatchObject({ code: ErrorCodes.success, data: { status: 'available' } })
    const opened = await invoke('scene-preview:open', event, scene)
    expect(opened.code).toBe(ErrorCodes.success)
    const openedData = dataOf(opened)
    const previewSessionId = String(openedData.previewSessionId)
    const contentBasis = openedData.contentBasis

    const saved = await invoke('scene-preview:save', event, {
      previewSessionId,
      requestId: 'request-1',
      baseContentBasis: contentBasis,
      edits: [{ dialogueId: '0', text: '跨层保存的一句' }]
    })
    expect(saved).toMatchObject({
      code: ErrorCodes.success,
      data: {
        status: 'saved',
        runtimeGeneration: 0,
        committedEdits: [{ dialogueId: '0', text: '跨层保存的一句' }],
        previewUpdate: { status: 'unavailable', reason: 'stageNeverPrepared' }
      }
    })

    const prepared = await invoke('scene-preview:prepare', event, { previewSessionId })
    expect(prepared).toMatchObject({
      code: ErrorCodes.success,
      data: {
        status: 'ready',
        stage: { phase: 'unknown', position: { kind: 'unknown' } }
      }
    })
    const preparedData = dataOf(prepared)
    expect(preparedData.stageUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/index\.html$/u)
    expect(JSON.stringify(prepared)).not.toContain(world.projectRoot)
    const revised = await readFile(join(world.projectRoot, 'game/scene/start.txt'), 'utf8')
    expect(revised).toBe('小明:跨层保存的一句 -figure=hero.png;\r\n')
    expect(revised).not.toContain('原来的正文')

    await invoke('scene-preview:close', event, { previewSessionId })
    const settlement = await invoke('scene-preview:settlement', event, {
      ...scene,
      requestId: 'request-1'
    })
    expect(settlement).toMatchObject({
      code: ErrorCodes.success,
      data: {
        status: 'saved',
        committedEdits: [{ dialogueId: '0', text: '跨层保存的一句' }]
      }
    })

    const missingCandidate = await invoke('scene-preview:read-candidate', event, {
      ...scene,
      previewSessionId: 'candidate-missing'
    })
    expect(missingCandidate).toMatchObject({
      code: ScenePreviewErrorCodes.candidateSessionMissing,
      msg: '候选预览会话不存在'
    })

    const savedBasis = dataOf(settlement).contentBasis
    const exported = await assembled.exporter.exportSavedScene({
      ...scene,
      contentBasis: savedBasis as { digest: string; parserVersion: string; engineVersion: string },
      versionReference: { kind: 'preview-save', requestId: 'request-1' }
    })
    expect(exported).toEqual({
      status: 'unavailable',
      reason: 'windowsPackagerUnavailable',
      message: '当前没有可调用的 Windows 桌面打包入口'
    })
    await expect(readFile(join(world.projectRoot, 'WebGAL.exe'))).rejects.toThrow()
    if (previous === undefined) delete process.env.OPENGALGAME_TERRE_WINDOWS_RELEASE
    else process.env.OPENGALGAME_TERRE_WINDOWS_RELEASE = previous
    await assembled.release()
  })

  it('未保存和候选身份在打包前拒绝，且不调用 Windows 打包', async () => {
    const world = await registeredScene()
    let packaged = 0
    const assembled = await assemble(world, trustedWindow().window)
    const exporter = new SceneExportApplicationServiceImpl({
      sources: new LocalSceneExportSourceGateway(
        world.userDirectory,
        versioning(world.userDirectory),
        assembled.sources
      ),
      packager: {
        async packageWindowsScene() {
          packaged += 1
          return { status: 'unavailable', reason: 'windowsPackagerUnavailable', message: '未调用' }
        }
      }
    })
    try {
      await expect(
        exporter.exportSavedScene({
          ...scene,
          contentBasis: { digest: 'a'.repeat(64), parserVersion: '4.6.5', engineVersion: '4.6.5' },
          versionReference: { kind: 'preview-save', requestId: 'missing-save' }
        })
      ).rejects.toMatchObject({ code: SceneExportErrorCodes.saveNotCommitted })
      await expect(
        exporter.exportSavedScene({
          ...scene,
          candidateSnapshotId: 'candidate-1',
          contentBasis: { digest: 'a'.repeat(64), parserVersion: '4.6.5', engineVersion: '4.6.5' },
          versionReference: { kind: 'preview-save', requestId: 'missing-save' }
        } as never)
      ).rejects.toMatchObject({ code: SceneExportErrorCodes.exportInputRejected })
      expect(packaged).toBe(0)
    } finally {
      await assembled.release()
    }
  })
})

async function invoke(
  channel: string,
  event: unknown,
  input: unknown
): Promise<{ code: number; msg: string; data?: Record<string, unknown> }> {
  const handler = ipc.handlers.get(channel)
  if (!handler) throw new Error(`通道未注册：${channel}`)
  return (await handler(event, input)) as {
    code: number
    msg: string
    data?: Record<string, unknown>
  }
}

function dataOf(result: { data?: Record<string, unknown> }): Record<string, unknown> {
  if (!result.data) throw new Error('响应没有数据')
  return result.data
}

async function assemble(
  world: { userDirectory: string; projectRoot: string },
  window: unknown
): Promise<{
  exporter: SceneExportApplicationServiceImpl
  sources: ScenePreviewSourceGateway
  release: () => Promise<void>
}> {
  const host = new WebgalRuntimeHostImpl({
    projectRoot: world.projectRoot,
    engineRoot: dirname(require.resolve('webgal-engine/package.json'))
  })
  const versionService = versioning(world.userDirectory)
  const preview = createScenePreview({
    userDirectory: world.userDirectory,
    versioning: versionService,
    sessionLookup: { findCandidatePreviewSession: () => undefined },
    host
  })
  const detach = registerScenePreviewIpc({
    getWindow: () => window as never,
    rendererUrl: 'http://127.0.0.1:5173/',
    scenePreview: new ScenePreviewController(
      preview.currentScenePreview,
      preview.candidatePreview,
      exceptions()
    )
  })
  return {
    exporter: new SceneExportApplicationServiceImpl({
      sources: new LocalSceneExportSourceGateway(
        world.userDirectory,
        versionService,
        preview.currentScene.sources
      ),
      packager: new TerreWindowsScenePackager(world.userDirectory)
    }),
    sources: preview.currentScene.sources,
    release: async () => {
      detach()
      preview.bridge.dispose()
      await host.dispose()
    }
  }
}

function versioning(userDirectory: string): ProjectVersioningApplicationServiceImpl {
  return new ProjectVersioningApplicationServiceImpl({
    ...createProjectVersioningGateways(userDirectory),
    nextId: () => `op-cross-${Math.random().toString(16).slice(2)}`
  })
}

function exceptions(): IpcExceptionHandler {
  const logger: LoggerGateway = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
  }
  return new IpcExceptionHandler(logger)
}

function trustedWindow(): {
  sender: { id: number; isDestroyed: () => boolean; send: () => undefined; once: () => undefined }
  frame: { url: string }
  window: {
    isDestroyed: () => boolean
    webContents: {
      id: number
      isDestroyed: () => boolean
      send: () => undefined
      once: () => undefined
      mainFrame: { url: string }
    }
  }
} {
  const sender = {
    id: 11,
    isDestroyed: () => false,
    send: () => undefined,
    once: () => undefined
  }
  const frame = { url: 'http://127.0.0.1:5173/' }
  return {
    sender,
    frame,
    window: {
      isDestroyed: () => false,
      webContents: Object.assign(sender, { mainFrame: frame })
    }
  }
}

async function registeredScene(): Promise<{ userDirectory: string; projectRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), 'preview-export-cross-'))
  roots.push(root)
  const userDirectory = join(root, 'user')
  const projectRoot = join(root, 'project')
  await mkdir(userDirectory)
  await mkdir(join(projectRoot, '.opengalgame/canvases', encodeStorageKey(scene.sceneId)), {
    recursive: true
  })
  await mkdir(join(projectRoot, 'game/scene'), { recursive: true })
  await mkdir(join(projectRoot, 'game/figure'), { recursive: true })
  await writeFile(
    join(projectRoot, '.opengalgame/project.json'),
    JSON.stringify({ id: scene.projectId, name: '跨层工程', synopsis: '' })
  )
  await writeFile(
    join(projectRoot, '.opengalgame/manifest.json'),
    JSON.stringify({ formatVersion: 2, projectId: scene.projectId, operationId: 'op-register' })
  )
  await writeFile(join(projectRoot, 'game/scene/start.txt'), script)
  await writeFile(join(projectRoot, 'game/figure/hero.png'), Uint8Array.of(1, 2, 3))
  await writeFile(
    join(projectRoot, '.opengalgame/scene-locks.json'),
    JSON.stringify({ scenes: [{ sceneId: scene.sceneId, lockState: 'unlocked' }] })
  )
  await writeFile(
    join(projectRoot, '.opengalgame/canvases', encodeStorageKey(scene.sceneId), 'canvas.json'),
    '{}'
  )
  await writeProjectRegistrations(userDirectory, [
    { id: scene.projectId, directory: projectRoot, operationId: 'op-register' }
  ])
  execFileSync('git', ['init'], { cwd: projectRoot })
  await createProjectVersioningGateways(userDirectory).transactions.initializeBaseline({
    projectId: scene.projectId,
    initialPaths: [
      'game/scene/start.txt',
      'game/figure/hero.png',
      '.opengalgame/scene-locks.json',
      '.opengalgame/project.json'
    ]
  })
  return { userDirectory, projectRoot }
}
