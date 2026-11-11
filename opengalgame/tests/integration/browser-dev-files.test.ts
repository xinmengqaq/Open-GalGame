import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import * as fs from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as git from 'isomorphic-git'

import { browserDevFilesPlugin } from '@bootstrap/browser/devFilePlugin'
import { createDevFileBackend, loadDevFileBackend } from '@bootstrap/browser/devFileBackend'
import { AppException } from '@common/errors/AppException'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { ProjectFileErrorCodes } from '@domain/project-files/errors/ProjectFileErrorCodes'
import { writeProjectRegistrations } from '@infrastructure/projects/projectRegistrations'

const directories: string[] = []

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

it('浏览器开发后端在真实工程里新建文件夹并保存正文，再次读取能看到结果', async () => {
  const userDirectory = await mkdtemp(join(tmpdir(), 'opengalgame-dev-user-'))
  const root = await mkdtemp(join(tmpdir(), 'opengalgame-dev-project-'))
  directories.push(userDirectory, root)
  await mkdir(join(root, '.opengalgame'), { recursive: true })
  await writeFile(
    join(root, '.opengalgame/manifest.json'),
    `${JSON.stringify({ formatVersion: 2, projectId: 'project-1', operationId: 'op-seed' }, null, 2)}\n`
  )
  await writeFile(
    join(root, '.opengalgame/project.json'),
    `${JSON.stringify({ id: 'project-1', name: '作品', synopsis: '', sceneId: 'scene-1', canvasId: 'canvas-1' }, null, 2)}\n`
  )
  await mkdir(join(root, 'game/scene'), { recursive: true })
  await writeFile(join(root, 'game/scene/start.txt'), '')
  await writeFile(
    join(root, '.opengalgame/scene-locks.json'),
    `${JSON.stringify({ scenes: [{ sceneId: 'scene-1', lockState: 'unlocked' }] }, null, 2)}\n`
  )
  const author = {
    name: 'opengalgame',
    email: 'opengalgame@localhost',
    timestamp: 1,
    timezoneOffset: 0
  }
  await git.init({ fs, dir: root, defaultBranch: 'main' })
  await git.add({ fs, dir: root, filepath: '.opengalgame/manifest.json' })
  await git.add({ fs, dir: root, filepath: '.opengalgame/project.json' })
  await git.add({ fs, dir: root, filepath: '.opengalgame/scene-locks.json' })
  await git.add({ fs, dir: root, filepath: 'game/scene/start.txt' })
  await git.commit({ fs, dir: root, message: '建立工程', author, committer: author })
  await writeProjectRegistrations(userDirectory, [
    { id: 'project-1', directory: root, operationId: 'op-register' }
  ])

  const backend = await createDevFileBackend(userDirectory)
  try {
    const listed = await backend.call('listProjects', { offset: 0, limit: 24 })
    expect(listed.code).toBe(ErrorCodes.success)
    expect(listed.data).toMatchObject({
      total: 1,
      entries: [{ status: 'available', id: 'project-1', name: '作品' }]
    })

    const catalog = await backend.call('listProjectInputSources', { projectId: 'project-1' })
    expect(catalog.code).toBe(ErrorCodes.success)
    const version = (catalog.data as { catalogVersion: string }).catalogVersion

    const created = await backend.call('createProjectFolder', {
      projectId: 'project-1',
      expectedCatalogVersion: version,
      parentFolderId: null,
      name: '临时目录'
    })
    expect(created.code).toBe(ErrorCodes.success)
    expect(created.data).toMatchObject({ name: '临时目录', parentFolderId: null })

    const again = await backend.call('listProjectInputSources', { projectId: 'project-1' })
    expect(again.code).toBe(ErrorCodes.success)
    expect(again.data).toMatchObject({
      folders: [{ name: '临时目录', parentFolderId: null }]
    })

    const createdText = await backend.call('createProjectTextFile', {
      projectId: 'project-1',
      expectedCatalogVersion: (again.data as { catalogVersion: string }).catalogVersion,
      parentFolderId: null,
      fileName: '正文.md',
      content: { textKind: 'document', format: 'markdown', body: '# 初稿' }
    })
    expect(createdText.code).toBe(ErrorCodes.success)
    const sourceId = (createdText.data as { sourceId: string }).sourceId
    const readInitial = await backend.call('readProjectInputSources', {
      projectId: 'project-1',
      sourceIds: [sourceId]
    })
    const initialVersion = (readInitial.data as { sources: { version: string }[] }).sources[0]
      ?.version

    const updated = await backend.call('updateProjectTextFileBody', {
      projectId: 'project-1',
      sourceId,
      expectedSourceVersion: initialVersion,
      content: { textKind: 'document', body: '# 二稿' }
    })
    expect(updated.code).toBe(ErrorCodes.success)
    expect(updated.data).toMatchObject({ sourceId, body: '# 二稿' })
    const reread = await backend.call('readProjectInputSources', {
      projectId: 'project-1',
      sourceIds: [sourceId]
    })
    expect(reread.data).toMatchObject({ sources: [{ body: '# 二稿' }] })

    const stale = await backend.call('updateProjectTextFileBody', {
      projectId: 'project-1',
      sourceId,
      expectedSourceVersion: initialVersion,
      content: { textKind: 'document', body: '# 过期写入' }
    })
    expect(stale).toMatchObject({ code: ProjectFileErrorCodes.textBodyChanged })

    const emptyArrangement = {
      projectId: 'project-1',
      sceneId: 'scene-1',
      canvasId: 'canvas-1',
      viewport: { x: 0, y: 0, zoom: 1 },
      cards: [],
      relations: []
    }
    const card = await backend.call('createSceneCanvasPromptCard', {
      projectId: 'project-1',
      sceneId: 'scene-1',
      canvasId: 'canvas-1',
      arrangement: emptyArrangement,
      layout: { x: 24, y: 32, width: 280, height: 180 }
    })
    expect(card.code).toBe(ErrorCodes.success)
    const saved = await backend.call('saveSceneCanvasArrangement', {
      projectId: 'project-1',
      sceneId: 'scene-1',
      canvasId: 'canvas-1',
      reason: 'manual',
      arrangement: card.data
    })
    expect(saved.code).toBe(ErrorCodes.success)
    const read = await backend.call('readSceneCanvasArrangement', {
      projectId: 'project-1',
      sceneId: 'scene-1',
      canvasId: 'canvas-1'
    })
    expect(read.code).toBe(ErrorCodes.success)
    expect(read.data).toMatchObject({
      cards: [{ kind: 'prompt', layout: { x: 24, y: 32 } }]
    })
  } finally {
    await backend.close()
  }
})

it('媒体开发路由只接受回环 GET，并按识别出的类型返回完整字节', async () => {
  const plugin = browserDevFilesPlugin()
  let handler:
    | ((request: IncomingMessage, response: ServerResponse, next: () => void) => Promise<void>)
    | undefined
  plugin.configureServer?.({
    middlewares: {
      use(next: typeof handler) {
        handler = next
      }
    },
    ssrLoadModule: async () => ({
      loadDevFileBackend: async () => ({
        call: async () => ({ code: 4101, msg: '请求参数格式不正确' }),
        stageFile: async () => ({ code: 4101, msg: '请求参数格式不正确' }),
        readMedia: async (input: { projectId?: string; sourceId?: string }) => {
          if (input.projectId !== 'project-1' || input.sourceId !== 'img-1') {
            return { code: 4328, msg: '来源记录不存在' }
          }
          return {
            code: 2000,
            msg: '媒体读取完成',
            data: {
              sourceId: 'img-1',
              contentKind: 'image',
              fileName: '屋顶.png',
              mediaType: 'image/png',
              bytes: Uint8Array.from([137, 80, 78, 71])
            }
          }
        },
        watchGenerationProgress: async () => ({
          result: { code: 4101, msg: '请求参数格式不正确' },
          stop() {
            return undefined
          }
        })
      })
    })
  } as never)
  if (!handler) throw new Error('媒体路由未注册')
  const server = createServer((request, response) => {
    void handler?.(request, response, () => {
      response.statusCode = 404
      response.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('测试端口不可用')
  try {
    const posted = await fetch(
      `http://127.0.0.1:${address.port}/__opengalgame/dev/media?projectId=project-1&sourceId=img-1`,
      { method: 'POST' }
    )
    expect(posted.status).toBe(405)
    const missing = await fetch(
      `http://127.0.0.1:${address.port}/__opengalgame/dev/media?projectId=project-1&sourceId=missing`
    )
    expect(missing.headers.get('content-type')).toContain('application/json')
    expect(await missing.json()).toEqual({ code: 4328, msg: '来源记录不存在' })
    const media = await fetch(
      `http://127.0.0.1:${address.port}/__opengalgame/dev/media?projectId=project-1&sourceId=img-1`
    )
    expect(media.status).toBe(200)
    expect(media.headers.get('content-type')).toBe('image/png')
    expect(media.headers.get('content-length')).toBe('4')
    expect(decodeURIComponent(media.headers.get('x-file-name') ?? '')).toBe('屋顶.png')
    expect(new Uint8Array(await media.arrayBuffer())).toEqual(Uint8Array.from([137, 80, 78, 71]))
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
  }
})

it('开发写入口拒绝跨站来源，同源请求仍进入后端', async () => {
  const plugin = browserDevFilesPlugin()
  const calls: string[] = []
  let handler:
    | ((request: IncomingMessage, response: ServerResponse, next: () => void) => Promise<void>)
    | undefined
  plugin.configureServer?.({
    middlewares: {
      use(next: typeof handler) {
        handler = next
      }
    },
    ssrLoadModule: async () => ({
      loadDevFileBackend: async () => ({
        call: async (method: string) => {
          calls.push(method)
          return { code: 2000, msg: '已打开', data: null }
        },
        stageFile: async () => ({ code: 2000, msg: '已暂存', data: 'staged' }),
        readMedia: async () => ({ code: 4101, msg: '请求参数格式不正确' }),
        watchGenerationProgress: async () => ({
          result: { code: 4101, msg: '请求参数格式不正确' },
          stop() {
            return undefined
          }
        }),
        subscribeScenePreviewEvents: () => () => undefined,
        subscribeCandidatePreviewEvents: () => () => undefined
      })
    })
  } as never)
  if (!handler) throw new Error('开发路由未注册')
  const server = createServer((request, response) => {
    void handler?.(request, response, () => {
      response.statusCode = 404
      response.end()
    })
  })
  const { promise: listening, resolve: started } = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', started)
  await listening
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('测试端口不可用')
  const callUrl = `http://127.0.0.1:${address.port}/__opengalgame/dev/call`
  try {
    const crossSite = await fetch(callUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://evil.example',
        'sec-fetch-site': 'cross-site'
      },
      body: JSON.stringify({ method: 'saveDialogueChanges', input: {} })
    })
    expect(crossSite.status).toBe(403)
    const crossOrigin = await fetch(callUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:9' },
      body: JSON.stringify({ method: 'exportSavedScene', input: {} })
    })
    expect(crossOrigin.status).toBe(403)
    const previewEvents = await fetch(
      `http://127.0.0.1:${address.port}/__opengalgame/dev/scene-preview-runtime`,
      { headers: { origin: 'http://evil.example' } }
    )
    expect(previewEvents.status).toBe(403)
    const sameOrigin = await fetch(callUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: `http://127.0.0.1:${address.port}`,
        'sec-fetch-site': 'same-origin'
      },
      body: JSON.stringify({ method: 'openScenePreview', input: {} })
    })
    expect(sameOrigin.status).toBe(200)
    expect(await sameOrigin.json()).toMatchObject({ code: 2000 })
    expect(calls).toEqual(['openScenePreview'])
  } finally {
    const { promise: closed, resolve: done, reject: failed } = Promise.withResolvers<void>()
    server.close((error) => (error ? failed(error) : done()))
    await closed
  }
})

it('开发启动把旧目录基线并入已有规范目录，再次启动不重复', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opengalgame-dev-recovery-'))
  directories.push(root)
  const canonical = join(root, '.opengalgame')
  const legacy = join(root, '.opengalgame ')
  const baseline = join(root, 'baseline')
  const imported = join(root, 'imported')
  await mkdir(baseline, { recursive: true })
  await mkdir(imported, { recursive: true })
  await writeProjectRegistrations(canonical, [
    { id: 'imported-1', directory: imported, operationId: 'op-imported-1' },
    { id: 'imported-2', directory: join(root, 'imported-2'), operationId: 'op-imported-2' }
  ])
  await writeProjectRegistrations(legacy, [
    { id: 'baseline', directory: baseline, operationId: 'op-baseline' }
  ])
  const previous = process.env.OPENGALGAME_DEV_USER_DIRECTORY
  process.env.OPENGALGAME_DEV_USER_DIRECTORY = canonical
  try {
    vi.resetModules()
    // 单例缓存在模块状态里，重复启动必须重新装载模块。
    const firstModule = await import('@bootstrap/browser/devFileBackend')
    const first = await firstModule.loadDevFileBackend()
    const listed = await first.call('listProjects', { offset: 0, limit: 24 })
    expect(listed.code).toBe(ErrorCodes.success)
    expect(listed.data).toMatchObject({
      total: 3,
      entries: expect.arrayContaining([expect.objectContaining({ id: 'baseline' })])
    })
    await first.close()

    vi.resetModules()
    // 第二次启动同样要丢掉上一次的模块单例。
    const secondModule = await import('@bootstrap/browser/devFileBackend')
    const second = await secondModule.loadDevFileBackend()
    const again = await second.call('listProjects', { offset: 0, limit: 24 })
    expect(again.data).toMatchObject({ total: 3 })
    await second.close()
  } finally {
    if (previous === undefined) delete process.env.OPENGALGAME_DEV_USER_DIRECTORY
    else process.env.OPENGALGAME_DEV_USER_DIRECTORY = previous
  }
})

it('开发用户目录带尾随空格时以 5101 拒绝且不创建该目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opengalgame-dev-invalid-'))
  directories.push(root)
  const spaced = join(root, '.opengalgame ')
  const previous = process.env.OPENGALGAME_DEV_USER_DIRECTORY
  process.env.OPENGALGAME_DEV_USER_DIRECTORY = spaced
  try {
    vi.resetModules()
    // 非法目录必须打到新装载的启动校验，不能复用已缓存的后端。
    const loaded = await import('@bootstrap/browser/devFileBackend')
    await expect(Promise.resolve().then(() => loaded.loadDevFileBackend())).rejects.toMatchObject({
      code: ErrorCodes.invalidConfig
    })
    expect(fs.existsSync(spaced)).toBe(false)
  } finally {
    if (previous === undefined) delete process.env.OPENGALGAME_DEV_USER_DIRECTORY
    else process.env.OPENGALGAME_DEV_USER_DIRECTORY = previous
  }
})

it('开发文件插件保留用户目录配置错误 5101', async () => {
  const plugin = browserDevFilesPlugin()
  const errors: string[] = []
  let handler:
    | ((request: IncomingMessage, response: ServerResponse, next: () => void) => Promise<void>)
    | undefined
  plugin.configureServer?.({
    config: { logger: { error: (message: string) => errors.push(message) } },
    middlewares: {
      use(next: typeof handler) {
        handler = next
      }
    },
    ssrLoadModule: async () => ({
      loadDevFileBackend: async () => {
        throw new AppException({ code: ErrorCodes.invalidConfig, msg: '用户目录无效' })
      }
    })
  } as never)
  if (!handler) throw new Error('开发路由未注册')
  const server = createServer((request, response) => {
    void handler?.(request, response, () => {
      response.statusCode = 404
      response.end()
    })
  })
  const { promise: listening, resolve: started } = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', started)
  await listening
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('测试端口不可用')
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/__opengalgame/dev/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'listProjects', input: { offset: 0, limit: 24 } })
    })
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ code: 5101, msg: '用户目录无效' })
    expect(errors).toEqual(['[opengalgame] 开发用户目录不可用（5101）'])
  } finally {
    const { promise: closed, resolve: done, reject: failed } = Promise.withResolvers<void>()
    server.close((error) => (error ? failed(error) : done()))
    await closed
  }
})
