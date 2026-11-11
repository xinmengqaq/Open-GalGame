import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WebgalRuntimeHostImpl } from '@infrastructure/webgal/runtime/WebgalRuntimeHostImpl'
import {
  buildEngineExtensionScriptUrl,
  ENGINE_EXTENSION_SCRIPT_PATH,
  ENGINE_EXTENSION_STATE_KEY
} from '@infrastructure/webgal/runtime/engineExtension'

const directories: string[] = []

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

describe('真实 WebGAL 运行时承载', () => {
  it('提供实际 dist、入口脚本和 assets 到 game 的只读映射，并拒绝越界', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opengalgame-webgal-runtime-'))
    const outside = await mkdtemp(join(tmpdir(), 'opengalgame-webgal-runtime-outside-'))
    directories.push(root)
    directories.push(outside)
    await mkdir(join(root, 'game'), { recursive: true })
    await mkdir(join(root, 'assets', 'background'), { recursive: true })
    await writeFile(join(outside, 'secret.txt'), 'outside', 'utf8')
    await symlink(outside, join(root, 'game', 'linked'), 'junction')
    await writeFile(join(root, 'game', 'start.txt'), '旁白:真实入口;\n', 'utf8')
    await writeFile(join(root, 'assets', 'background', 'room.webp'), Buffer.from([1, 2, 3]))
    await writeFile(
      join(root, 'assets', 'background', 'station.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"/>'
    )
    const requests: string[] = []
    const host = new WebgalRuntimeHostImpl({
      projectRoot: root,
      engineRoot: join(process.cwd(), 'node_modules', 'webgal-engine')
    })
    const removeRequests = host.onRequest((request) =>
      requests.push(`${request.statusCode} ${request.path}`)
    )
    const handle = await host.start()
    try {
      const index = await fetch(`${handle.baseUrl}/index.html`)
      const rootIndex = await fetch(`${handle.baseUrl}/`)
      const head = await fetch(`${handle.baseUrl}/index.html`, { method: 'HEAD' })
      const post = await fetch(`${handle.baseUrl}/index.html`, { method: 'POST' })
      const entry = await fetch(`${handle.baseUrl}/game/start.txt`)
      const asset = await fetch(`${handle.baseUrl}/game/background/room.webp`)
      const vector = await fetch(`${handle.baseUrl}/game/background/station.svg`)
      const linked = await fetch(`${handle.baseUrl}/game/linked/secret.txt`)
      const traversal = await fetch(`${handle.baseUrl}/game/background/%2e%2e/%2e%2e/package.json`)

      expect(index.status).toBe(200)
      expect(rootIndex.status).toBe(200)
      expect(head.status).toBe(200)
      expect(head.headers.get('content-length')).toBe(index.headers.get('content-length'))
      expect((await head.arrayBuffer()).byteLength).toBe(0)
      expect(post.status).toBe(405)
      expect(await index.text()).toContain('WebGAL')
      expect(index.headers.get('content-security-policy')).toBeNull()
      expect(entry.status).toBe(200)
      expect(await entry.text()).toContain('真实入口')
      expect(asset.status).toBe(200)
      expect(vector.headers.get('content-type')).toBe('image/svg+xml')
      expect(new Uint8Array(await asset.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
      expect(linked.status).toBe(404)
      expect(traversal.status).not.toBe(200)
      expect(requests).toEqual(
        expect.arrayContaining(['200 /game/start.txt', '200 /game/background/room.webp'])
      )
    } finally {
      removeRequests()
      await host.dispose()
    }
  })

  it('缺失的可选 game 文件返回导出链同款默认资源，未列出的路径仍 404', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opengalgame-webgal-runtime-default-assets-'))
    directories.push(root)
    await mkdir(join(root, 'game'), { recursive: true })
    const defaultGameConfig = 'Game_name:当前场景;\nGame_key:;\nTitle_img:;\nTitle_bgm:;\n'
    const requests: string[] = []
    const host = new WebgalRuntimeHostImpl({
      projectRoot: root,
      engineRoot: join(process.cwd(), 'node_modules', 'webgal-engine')
    })
    const removeRequests = host.onRequest((request) =>
      requests.push(`${request.statusCode} ${request.path}`)
    )
    const handle = await host.start()
    try {
      const config = await fetch(`${handle.baseUrl}/game/config.txt`)
      expect(config.status).toBe(200)
      expect(config.headers.get('content-type')).toBe('text/plain; charset=utf-8')
      expect(config.headers.get('cache-control')).toBe('no-store')
      expect(await config.text()).toBe(defaultGameConfig)

      const style = await fetch(`${handle.baseUrl}/game/userStyleSheet.css`)
      expect(style.status).toBe(200)
      expect(style.headers.get('content-type')).toBe('text/css; charset=utf-8')
      expect(await style.text()).toBe('html,body{background:#000}\n')

      const template = await fetch(`${handle.baseUrl}/game/template/template.json`)
      expect(template.status).toBe(200)
      expect(template.headers.get('content-type')).toBe('application/json; charset=utf-8')
      expect(await template.text()).toBe('{}')

      const animationTable = await fetch(`${handle.baseUrl}/game/animation/animationTable.json`)
      expect(animationTable.status).toBe(200)
      expect(animationTable.headers.get('content-type')).toBe('application/json; charset=utf-8')
      expect(await animationTable.text()).toBe('[]')
      const animationTableHead = await fetch(
        `${handle.baseUrl}/game/animation/animationTable.json`,
        { method: 'HEAD' }
      )
      expect(animationTableHead.status).toBe(200)
      expect(animationTableHead.headers.get('content-length')).toBe(
        animationTable.headers.get('content-length')
      )
      expect((await animationTableHead.arrayBuffer()).byteLength).toBe(0)

      const missingEntry = await fetch(`${handle.baseUrl}/game/start.txt`)
      expect(missingEntry.status).toBe(404)
      expect(await missingEntry.text()).toBe('运行时文件不存在')
      const nearMiss = await fetch(`${handle.baseUrl}/game/template/other.json`)
      expect(nearMiss.status).toBe(404)
      expect(await nearMiss.text()).toBe('运行时文件不存在')

      expect(requests).toEqual(
        expect.arrayContaining([
          '200 /game/config.txt',
          '200 /game/userStyleSheet.css',
          '200 /game/template/template.json',
          '200 /game/animation/animationTable.json',
          '404 /game/start.txt',
          '404 /game/template/other.json'
        ])
      )
    } finally {
      removeRequests()
      await host.dispose()
    }
  })

  it('工程内同名文件优先于默认资源，删除后回落默认内容', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opengalgame-webgal-runtime-default-override-'))
    directories.push(root)
    await mkdir(join(root, 'game', 'template'), { recursive: true })
    await writeFile(join(root, 'game', 'config.txt'), 'Game_name:工程配置;\n', 'utf8')
    await writeFile(join(root, 'game', 'template', 'template.json'), '{"custom":true}', 'utf8')
    const host = new WebgalRuntimeHostImpl({
      projectRoot: root,
      engineRoot: join(process.cwd(), 'node_modules', 'webgal-engine')
    })
    const handle = await host.start()
    try {
      const config = await fetch(`${handle.baseUrl}/game/config.txt`)
      expect(config.status).toBe(200)
      expect(config.headers.get('content-type')).toBe('text/plain; charset=utf-8')
      expect(await config.text()).toBe('Game_name:工程配置;\n')

      const template = await fetch(`${handle.baseUrl}/game/template/template.json`)
      expect(template.status).toBe(200)
      expect(template.headers.get('content-type')).toBe('application/json; charset=utf-8')
      expect(await template.text()).toBe('{"custom":true}')

      await rm(join(root, 'game', 'config.txt'))
      const fallback = await fetch(`${handle.baseUrl}/game/config.txt`)
      expect(fallback.status).toBe(200)
      expect(await fallback.text()).toBe(
        'Game_name:当前场景;\nGame_key:;\nTitle_img:;\nTitle_bgm:;\n'
      )
    } finally {
      await host.dispose()
    }
  })

  it('只覆盖当前会话的场景入口，旧修订、越界和清除都不改磁盘', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opengalgame-webgal-runtime-overlay-'))
    directories.push(root)
    await mkdir(join(root, 'game', 'scene'), { recursive: true })
    const entry = join(root, 'game', 'scene', 'start.txt')
    await writeFile(entry, '旁白:磁盘原文;\n', 'utf8')
    const host = new WebgalRuntimeHostImpl({
      projectRoot: root,
      engineRoot: join(process.cwd(), 'node_modules', 'webgal-engine')
    })
    const handle = await host.start()
    const overlay = '旁白:内存草稿;\n'
    const digest = createHash('sha256').update(overlay, 'utf8').digest('hex')
    try {
      await host.setSceneTextOverlay({
        previewSessionId: 'scene-a',
        sceneFileName: 'start.txt',
        editRevision: 2,
        text: overlay,
        digest,
        runtimeGeneration: 1
      })
      const covered = await fetch(`${handle.baseUrl}/game/scene/start.txt`)
      const escaped = await fetch(`${handle.baseUrl}/game/scene/../start.txt`)
      expect(await covered.text()).toBe(overlay)
      expect(escaped.status).not.toBe(200)
      await expect(
        host.setSceneTextOverlay({
          previewSessionId: 'other-session',
          sceneFileName: 'start.txt',
          editRevision: 3,
          text: overlay,
          digest,
          runtimeGeneration: 1
        })
      ).rejects.toThrow('场景覆盖不可用')
      await expect(
        host.setSceneTextOverlay({
          previewSessionId: 'scene-a',
          sceneFileName: 'start.txt',
          editRevision: 1,
          text: '旁白:旧草稿;\n',
          digest,
          runtimeGeneration: 1
        })
      ).rejects.toThrow('场景覆盖不可用')
      await host.clearSceneTextOverlay({ previewSessionId: 'scene-a', runtimeGeneration: 1 })
      expect(await (await fetch(`${handle.baseUrl}/game/scene/start.txt`)).text()).toBe(
        '旁白:磁盘原文;\n'
      )
      expect(await readFile(entry, 'utf8')).toBe('旁白:磁盘原文;\n')
    } finally {
      await host.dispose()
    }
  })

  it('旧修订被拒绝后仍提供已接受修订的场景文本', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opengalgame-webgal-runtime-stale-'))
    directories.push(root)
    await mkdir(join(root, 'game', 'scene'), { recursive: true })
    const entry = join(root, 'game', 'scene', 'start.txt')
    await writeFile(entry, '旁白:磁盘原文;\n', 'utf8')
    const host = new WebgalRuntimeHostImpl({
      projectRoot: root,
      engineRoot: join(process.cwd(), 'node_modules', 'webgal-engine')
    })
    const handle = await host.start()
    const current = '旁白:修订二;\n'
    const older = '旁白:修订一;\n'
    try {
      await host.setSceneTextOverlay({
        previewSessionId: 'scene-a',
        sceneFileName: 'start.txt',
        editRevision: 2,
        text: current,
        digest: createHash('sha256').update(current, 'utf8').digest('hex'),
        runtimeGeneration: 1
      })
      await expect(
        host.setSceneTextOverlay({
          previewSessionId: 'scene-a',
          sceneFileName: 'start.txt',
          editRevision: 1,
          text: older,
          digest: createHash('sha256').update(older, 'utf8').digest('hex'),
          runtimeGeneration: 1
        })
      ).rejects.toThrow('场景覆盖不可用')
      expect(await (await fetch(`${handle.baseUrl}/game/scene/start.txt`)).text()).toBe(current)
      expect(await readFile(entry, 'utf8')).toBe('旁白:磁盘原文;\n')
    } finally {
      await host.dispose()
    }
  })

  it('为真实引擎回显固定预览协议子协议并处理注册请求', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opengalgame-webgal-runtime-protocol-'))
    directories.push(root)
    await mkdir(join(root, 'game'), { recursive: true })
    await writeFile(join(root, 'game', 'start.txt'), '旁白:协议握手;\n', 'utf8')
    const host = new WebgalRuntimeHostImpl({
      projectRoot: root,
      engineRoot: join(process.cwd(), 'node_modules', 'webgal-engine')
    })
    const removePreviewListener = host.onPreviewConnection((connection) => {
      connection.onMessage((message) => {
        const request = message as { kind?: unknown; type?: unknown; requestId?: unknown }
        if (
          request.kind !== 'request' ||
          request.type !== 'session.register-preview' ||
          typeof request.requestId !== 'string'
        )
          return
        connection.send({
          kind: 'response',
          type: 'session.register-preview',
          requestId: request.requestId,
          payload: { sessionId: connection.id }
        })
      })
    })
    const handle = await host.start()
    const socket = new WebSocket(handle.previewUrl, 'webgal-editor-preview-sync.v1')
    try {
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve(), { once: true })
        socket.addEventListener('error', () => reject(new Error('WebSocket 握手失败')), {
          once: true
        })
      })
      expect(socket.protocol).toBe('webgal-editor-preview-sync.v1')
      const response = new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('注册响应超时')), 1000)
        socket.addEventListener(
          'message',
          (event) => {
            clearTimeout(timer)
            resolve(JSON.parse(String(event.data)))
          },
          { once: true }
        )
      })
      socket.send(
        JSON.stringify({
          kind: 'request',
          type: 'session.register-preview',
          requestId: 'register-1',
          payload: { gameId: 'fixture' }
        })
      )
      await expect(response).resolves.toMatchObject({
        kind: 'response',
        type: 'session.register-preview',
        requestId: 'register-1'
      })
    } finally {
      socket.close()
      removePreviewListener()
      await host.dispose()
      await host.dispose()
    }
  })

  it('向引擎入口注入自制扩展脚本，并只在该路由提供脚本', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opengalgame-webgal-runtime-extension-'))
    directories.push(root)
    await mkdir(join(root, 'game'), { recursive: true })
    await writeFile(join(root, 'game', 'start.txt'), '旁白:扩展入口;\n', 'utf8')
    const requests: string[] = []
    const host = new WebgalRuntimeHostImpl({
      projectRoot: root,
      engineRoot: join(process.cwd(), 'node_modules', 'webgal-engine')
    })
    const removeRequests = host.onRequest((request) =>
      requests.push(`${request.statusCode} ${request.path}`)
    )
    const handle = await host.start()
    try {
      const index = await fetch(`${handle.baseUrl}/index.html`)
      const html = await index.text()
      expect(html).toContain(ENGINE_EXTENSION_SCRIPT_PATH)
      expect(html).toContain('engine=')
      expect(html).toContain('supported=')
      expect(html.indexOf(ENGINE_EXTENSION_SCRIPT_PATH)).toBeLessThan(html.lastIndexOf('</body>'))
      const rootIndex = await fetch(`${handle.baseUrl}/`)
      expect(await rootIndex.text()).toContain(ENGINE_EXTENSION_SCRIPT_PATH)

      const scriptUrl = buildEngineExtensionScriptUrl({
        engineVersion: handle.build.engineVersion
      })
      const script = await fetch(`${handle.baseUrl}${scriptUrl}`)
      expect(script.status).toBe(200)
      expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
      expect(script.headers.get('cache-control')).toBe('no-store')
      expect(await script.text()).toContain(ENGINE_EXTENSION_STATE_KEY)

      const head = await fetch(`${handle.baseUrl}${scriptUrl}`, { method: 'HEAD' })
      expect(head.status).toBe(200)
      expect(head.headers.get('content-length')).toBe(script.headers.get('content-length'))

      const post = await fetch(`${handle.baseUrl}${scriptUrl}`, { method: 'POST' })
      expect(post.status).toBe(405)

      expect(requests).toEqual(
        expect.arrayContaining([`200 ${ENGINE_EXTENSION_SCRIPT_PATH}`, '200 /index.html', '200 /'])
      )
    } finally {
      removeRequests()
      await host.dispose()
    }
  }, 20_000)

  it('关闭扩展时不注入脚本，扩展路由按不存在处理', async () => {
    const root = await mkdtemp(join(tmpdir(), 'opengalgame-webgal-runtime-extension-off-'))
    directories.push(root)
    await mkdir(join(root, 'game'), { recursive: true })
    await writeFile(join(root, 'game', 'start.txt'), '旁白:扩展关闭;\n', 'utf8')
    const host = new WebgalRuntimeHostImpl({
      projectRoot: root,
      engineRoot: join(process.cwd(), 'node_modules', 'webgal-engine'),
      engineExtension: { enabled: false }
    })
    const handle = await host.start()
    try {
      const html = await (await fetch(`${handle.baseUrl}/index.html`)).text()
      expect(html).not.toContain(ENGINE_EXTENSION_SCRIPT_PATH)
      const script = await fetch(`${handle.baseUrl}${ENGINE_EXTENSION_SCRIPT_PATH}`)
      expect(script.status).toBe(404)
    } finally {
      await host.dispose()
    }
  }, 20_000)
})
