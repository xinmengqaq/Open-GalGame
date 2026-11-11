import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ProjectVersioningApplicationServiceImpl } from '@application/project-versioning/services/impl/ProjectVersioningApplicationServiceImpl'
import { createSceneExport } from '@bootstrap/sceneExport'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { SceneExportErrorCodes } from '@domain/scene-export/errors/SceneExportErrorCodes'
import type { LoggerGateway } from '@common/logging/LoggerGateway'
import { createProjectVersioningGateways } from '@infrastructure/project-versioning/createProjectVersioningGateways'
import { encodeStorageKey } from '@infrastructure/project-files/projectFilePaths'
import { writeProjectRegistrations } from '@infrastructure/projects/projectRegistrations'
import { LocalSceneDialogueRevisionGateway } from '@infrastructure/scene-preview/LocalSceneDialogueRevisionGateway'
import { LocalPreviewSaveVersionGateway } from '@infrastructure/scene-preview/LocalPreviewSaveVersionGateway'
import { LocalScenePreviewSourceGateway } from '@infrastructure/scene-preview/LocalScenePreviewSourceGateway'
import { SceneAssetReferenceGatewayImpl } from '@infrastructure/scenes/SceneAssetReferenceGatewayImpl'
import { SceneScriptParserGatewayImpl } from '@infrastructure/scenes/SceneScriptParserGatewayImpl'
import { SceneSourceReaderGatewayImpl } from '@infrastructure/scenes/SceneSourceReaderGatewayImpl'
import { RegisteredSceneLocationGatewayImpl } from '@infrastructure/scenes/RegisteredSceneLocationGatewayImpl'
import { IpcExceptionHandler } from '@interfaces/ipc/errors/IpcExceptionHandler'
import { SceneExportClientImpl } from '@interfaces/scene-export/client/SceneExportClientImpl'
import { SceneExportController } from '@interfaces/scene-export/ipc/SceneExportController'
import { registerSceneExportIpc } from '@interfaces/scene-export/ipc/registerSceneExportIpc'
import { createDesktopBridge } from '@interfaces/preload/DesktopBridge'
import { AppException } from '@common/errors/AppException'

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

const roots: string[] = []
const scene = { projectId: 'project-1', sceneId: 'scene-1' }
const script = '小明:已保存的一句 -figure=hero.png;\r\n'

afterEach(async () => {
  ipc.handlers.clear()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('已保存场景导出 IPC', () => {
  it('保存成功后经固定通道返回 Windows 打包不可用，且响应不含路径', async () => {
    const world = await registeredScene()
    const previous = process.env.OPENGALGAME_TERRE_WINDOWS_RELEASE
    process.env.OPENGALGAME_TERRE_WINDOWS_RELEASE = join(world.userDirectory, 'missing-terre.zip')
    const saved = await saveScene(world)
    const trusted = trustedWindow()
    const detach = register(world.userDirectory, trusted.window)
    const event = { sender: trusted.sender, senderFrame: trusted.frame }
    const bridge = createDesktopBridge({
      invoke: async (channel, input) => {
        const handler = ipc.handlers.get(channel)
        if (!handler) throw new Error(`通道未注册：${channel}`)
        return handler(event, input)
      },
      subscribe: () => () => undefined
    })

    const exported = await new SceneExportClientImpl(bridge).exportSavedScene(saved)
    expect(exported).toEqual({
      code: ErrorCodes.success,
      msg: '场景导出已返回',
      data: {
        status: 'unavailable',
        reason: 'windowsPackagerUnavailable',
        message: '当前没有可调用的 Windows 桌面打包入口'
      }
    })
    expect(JSON.stringify(exported)).not.toContain(world.projectRoot)
    expect(JSON.stringify(exported)).not.toContain('WebGAL.exe')
    await expect(readFile(join(world.projectRoot, 'WebGAL.exe'))).rejects.toThrow()
    if (previous === undefined) delete process.env.OPENGALGAME_TERRE_WINDOWS_RELEASE
    else process.env.OPENGALGAME_TERRE_WINDOWS_RELEASE = previous
    detach()
  })

  it('未保存、候选、草稿、路径和命令经通道拒绝，且不留下可执行文件', async () => {
    const world = await registeredScene()
    const trusted = trustedWindow()
    const detach = register(world.userDirectory, trusted.window)
    const event = { sender: trusted.sender, senderFrame: trusted.frame }
    const basis = { digest: 'a'.repeat(64), parserVersion: '4.6.5', engineVersion: '4.6.5' }
    const missing = {
      ...scene,
      contentBasis: basis,
      versionReference: { kind: 'preview-save', requestId: 'missing-save' }
    }

    await expect(invoke(event, missing)).resolves.toMatchObject({
      code: SceneExportErrorCodes.saveNotCommitted
    })
    await expect(
      invoke(event, { ...missing, candidateSnapshotId: 'candidate-1' })
    ).resolves.toMatchObject({
      code: ErrorCodes.invalidRequest
    })
    await expect(invoke(event, { ...missing, draftText: '未保存草稿' })).resolves.toMatchObject({
      code: ErrorCodes.invalidRequest
    })
    await expect(
      invoke(event, { ...missing, outputPath: join(world.projectRoot, 'WebGAL.exe') })
    ).resolves.toMatchObject({
      code: ErrorCodes.invalidRequest
    })
    await expect(invoke(event, { ...missing, command: 'electron-builder' })).resolves.toMatchObject(
      {
        code: ErrorCodes.invalidRequest
      }
    )
    await expect(readFile(join(world.projectRoot, 'WebGAL.exe'))).rejects.toThrow()
    detach()
  })
})

async function invoke(
  event: unknown,
  input: unknown
): Promise<{ code: number; msg: string; data?: unknown }> {
  const handler = ipc.handlers.get('scene-export:export-saved-scene')
  if (!handler) throw new Error('导出通道未注册')
  return (await handler(event, input)) as { code: number; msg: string; data?: unknown }
}

function register(userDirectory: string, window: unknown): () => void {
  const versionService = versioning(userDirectory)
  const sources = new LocalScenePreviewSourceGateway(
    new RegisteredSceneLocationGatewayImpl(userDirectory),
    new SceneSourceReaderGatewayImpl(),
    new SceneScriptParserGatewayImpl(),
    new SceneAssetReferenceGatewayImpl()
  )
  return registerSceneExportIpc({
    getWindow: () => window as never,
    rendererUrl: 'http://127.0.0.1:5173/',
    sceneExport: new SceneExportController(
      createSceneExport({ userDirectory, versioning: versionService, sources }),
      exceptions()
    )
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

function versioning(userDirectory: string): ProjectVersioningApplicationServiceImpl {
  return new ProjectVersioningApplicationServiceImpl({
    ...createProjectVersioningGateways(userDirectory),
    nextId: () => `op-export-ipc-${Math.random().toString(16).slice(2)}`
  })
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
    id: 21,
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

async function saveScene(world: { userDirectory: string }): Promise<{
  projectId: string
  sceneId: string
  contentBasis: { digest: string; parserVersion: string; engineVersion: string }
  versionReference: { kind: 'preview-save'; requestId: string }
}> {
  const reader = new LocalScenePreviewSourceGateway(
    new RegisteredSceneLocationGatewayImpl(world.userDirectory),
    new SceneSourceReaderGatewayImpl(),
    new SceneScriptParserGatewayImpl(),
    new SceneAssetReferenceGatewayImpl()
  )
  const source = await reader.readScenePreviewSource(scene)
  const revision = await new LocalSceneDialogueRevisionGateway().prepareDialogueRevision(source, {
    scene,
    changedEdits: [{ dialogueId: '0', text: '导出前保存的一句' }],
    unchangedEdits: []
  })
  const saved = await new LocalPreviewSaveVersionGateway(
    world.userDirectory,
    versioning(world.userDirectory),
    reader
  ).commitPreviewSave({
    ...scene,
    requestId: 'request-1',
    baseContentBasis: source.contentBasis,
    editsSnapshot: JSON.stringify([{ dialogueId: '0', text: '导出前保存的一句' }]),
    committedEdits: [{ dialogueId: '0', text: '导出前保存的一句' }],
    revision
  })
  if (saved.status !== 'committed') throw new AppException({ code: 1, msg: '测试保存没有成功' })
  return {
    ...scene,
    contentBasis: saved.contentBasis,
    versionReference: { kind: 'preview-save', requestId: 'request-1' }
  }
}

async function registeredScene(): Promise<{ userDirectory: string; projectRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), 'scene-export-ipc-'))
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
    JSON.stringify({ id: scene.projectId, name: '导出工程', synopsis: '' })
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
