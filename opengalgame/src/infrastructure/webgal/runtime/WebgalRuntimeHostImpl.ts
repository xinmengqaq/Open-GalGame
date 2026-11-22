import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { lstat, realpath, readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'

import { isInsideRoot, projectPathsForGameRequest } from '@infrastructure/webgal/assetPath'
import {
  assertWebgalRuntimeCompatibility,
  WEBGAL_COMPATIBILITY_PROFILE,
  type WebgalRuntimeBuildEvidence
} from '@infrastructure/webgal/compatibility/WebgalCompatibilityProfile'
import { defaultRuntimeAssetFor } from '@infrastructure/webgal/runtime/defaultRuntimeAssets'
import {
  buildEngineExtensionScriptTag,
  DEFAULT_SUPPORTED_ENGINE_VERSIONS,
  ENGINE_EXTENSION_SCRIPT,
  ENGINE_EXTENSION_SCRIPT_PATH,
  injectEngineExtensionHtml,
  type EngineExtensionOptions
} from '@infrastructure/webgal/runtime/engineExtension'

export interface WebgalRuntimeRequest {
  readonly path: string
  readonly statusCode: number
}

export interface WebgalPreviewConnection {
  readonly id: string
  send(message: unknown): void
  onMessage(listener: (message: unknown) => void): () => void
  onClose(listener: (reason?: string) => void): () => void
  close(): void
}

export interface WebgalRuntimeHandle {
  readonly baseUrl: string
  readonly previewUrl: string
  readonly port: number
  readonly build: WebgalRuntimeBuildEvidence
  /** 宿主是否启用了受限自动开始；只有启用时才等待真实游戏快照。 */
  readonly autoStart: boolean
}

export interface WebgalRuntimeHost {
  start(): Promise<WebgalRuntimeHandle>
  onPreviewConnection(listener: (connection: WebgalPreviewConnection) => void): () => void
  onRequest(listener: (request: WebgalRuntimeRequest) => void): () => void
  getHandle(): WebgalRuntimeHandle | undefined
  useProjectRoot(projectRoot: string): Promise<void>
  setSceneTextOverlay(overlay: SceneTextOverlay): Promise<void>
  currentSceneTextOverlayRevision(scope: SceneTextOverlayScope): Promise<number>
  clearSceneTextOverlay(scope: SceneTextOverlayScope): Promise<void>
  previewConnections(): readonly WebgalPreviewConnection[]
  dispose(): Promise<void>
}

export interface WebgalRuntimeHostOptions {
  readonly projectRoot?: string
  readonly engineRoot: string
  readonly host?: string
  readonly port?: number
  readonly engineExtension?: EngineExtensionOptions
}

export interface SceneTextOverlay {
  readonly previewSessionId: string
  readonly sceneFileName: string
  readonly editRevision: number
  readonly text: string
  readonly digest: string
  readonly runtimeGeneration: number
}

export interface SceneTextOverlayScope {
  readonly previewSessionId: string
  readonly runtimeGeneration?: number
}

export type SceneOverlayUnavailableReason =
  'stale-revision' | 'stale-generation' | 'foreign-session' | 'digest-mismatch' | 'invalid-overlay'

export class SceneOverlayUnavailable extends Error {
  readonly name = 'SceneOverlayUnavailable'

  constructor(readonly reason: SceneOverlayUnavailableReason) {
    super('场景覆盖不可用')
  }
}

interface ActiveSceneTextOverlay extends SceneTextOverlay {
  readonly acceptedAt: number
}

const contentTypes: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  webm: 'video/webm'
}

function contentType(path: string): string {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  return contentTypes[extension] ?? 'application/octet-stream'
}

function safePathname(pathname: string): string | undefined {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return undefined
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return undefined
  const normalized = decoded.replace(/^\/+/, '')
  if (normalized.split('/').some((part) => part === '..')) return undefined
  return normalized
}

function writeText(response: ServerResponse, statusCode: number, body: string): void {
  response.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  response.end(body)
}

type ResolvedRuntimeFile =
  | { readonly kind: 'file'; readonly filePath: string }
  | { readonly kind: 'default-asset'; readonly body: string; readonly contentType: string }

class WsPreviewConnection implements WebgalPreviewConnection {
  readonly id = `preview-${Date.now()}-${Math.random().toString(16).slice(2)}`
  private readonly messageListeners = new Set<(message: unknown) => void>()
  private readonly closeListeners = new Set<(reason?: string) => void>()
  private closed = false

  constructor(private readonly socket: WebSocket) {
    socket.on('message', (data) => {
      let message: unknown
      try {
        message = JSON.parse(data.toString())
      } catch {
        return
      }
      for (const listener of this.messageListeners) listener(message)
    })
    socket.on('close', () => this.finish('socket closed'))
    socket.on('error', (error) => this.finish(error.message))
  }

  send(message: unknown): void {
    if (this.closed || this.socket.readyState !== this.socket.OPEN) {
      throw new Error('WebGAL 预览连接已关闭')
    }
    this.socket.send(JSON.stringify(message))
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.messageListeners.add(listener)
    return () => this.messageListeners.delete(listener)
  }

  onClose(listener: (reason?: string) => void): () => void {
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  close(): void {
    if (this.closed) return
    this.socket.close()
    this.finish('closed by host')
  }

  private finish(reason?: string): void {
    if (this.closed) return
    this.closed = true
    for (const listener of this.closeListeners) listener(reason)
    this.messageListeners.clear()
    this.closeListeners.clear()
  }
}

export class WebgalRuntimeHostImpl implements WebgalRuntimeHost {
  private readonly previewListeners = new Set<(connection: WebgalPreviewConnection) => void>()
  private readonly requestListeners = new Set<(request: WebgalRuntimeRequest) => void>()
  private readonly connections = new Set<WsPreviewConnection>()
  private server: ReturnType<typeof createServer> | undefined
  private sockets: WebSocketServer | undefined
  private projectRoot: string | undefined
  private engineDist: string | undefined
  private runtimeBuild: WebgalRuntimeBuildEvidence | undefined
  private handle: WebgalRuntimeHandle | undefined
  private sceneOverlay: ActiveSceneTextOverlay | undefined
  private overlaySerial = 0

  constructor(private readonly options: WebgalRuntimeHostOptions) {}

  async start(): Promise<WebgalRuntimeHandle> {
    if (this.handle) return this.handle
    const configuredRoot = this.options.projectRoot
    if (configuredRoot !== undefined) {
      this.projectRoot = await realpath(resolve(configuredRoot))
    }
    const engineRoot = await realpath(resolve(this.options.engineRoot))
    this.engineDist = join(engineRoot, 'dist')
    const build = await assertWebgalRuntimeCompatibility(engineRoot)
    this.runtimeBuild = build
    this.server = createServer((request, response) => {
      void this.serve(request, response)
    })
    this.sockets = new WebSocketServer({
      noServer: true,
      handleProtocols: (protocols) =>
        protocols.has(WEBGAL_COMPATIBILITY_PROFILE.previewProtocol)
          ? WEBGAL_COMPATIBILITY_PROFILE.previewProtocol
          : false
    })
    this.server.on('upgrade', (request, socket, head) => this.upgrade(request, socket, head))
    await new Promise<void>((resolveListen, reject) => {
      const server = this.server
      if (!server) return reject(new Error('WebGAL 运行时服务器未创建'))
      const onError = (error: Error): void => {
        server.off('error', onError)
        reject(error)
      }
      server.once('error', onError)
      server.listen(this.options.port ?? 0, this.options.host ?? '127.0.0.1', () => {
        server.off('error', onError)
        resolveListen()
      })
    })
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('无法取得 WebGAL 运行时端口')
    const host = this.options.host ?? '127.0.0.1'
    const baseUrl = `http://${host}:${address.port}`
    this.handle = {
      baseUrl,
      previewUrl: `ws://${host}:${address.port}${WEBGAL_COMPATIBILITY_PROFILE.previewPath}`,
      port: address.port,
      build,
      autoStart: this.engineExtensionEnabled() && this.options.engineExtension?.autoStart === true
    }
    return this.handle
  }

  onPreviewConnection(listener: (connection: WebgalPreviewConnection) => void): () => void {
    this.previewListeners.add(listener)
    return () => this.previewListeners.delete(listener)
  }

  onRequest(listener: (request: WebgalRuntimeRequest) => void): () => void {
    this.requestListeners.add(listener)
    return () => this.requestListeners.delete(listener)
  }
  getHandle(): WebgalRuntimeHandle | undefined {
    return this.handle
  }

  async useProjectRoot(projectRoot: string): Promise<void> {
    if (!isAbsolute(projectRoot)) throw new Error('预览工程根不可用')
    let lexical: string
    let resolved: string
    try {
      lexical = resolve(projectRoot)
      const linked = await lstat(lexical)
      const manifest = await lstat(join(lexical, '.opengalgame', 'manifest.json'))
      if (linked.isSymbolicLink() || !linked.isDirectory() || !manifest.isFile()) {
        throw new Error('预览工程根不可用')
      }
      resolved = await realpath(lexical)
      if (!isInsideRoot(lexical, resolved)) throw new Error('预览工程根不可用')
    } catch (error) {
      if (error instanceof Error && error.message === '预览工程根不可用') throw error
      throw new Error('预览工程根不可用')
    }
    if (this.projectRoot !== resolved) this.sceneOverlay = undefined
    this.projectRoot = resolved
  }

  async setSceneTextOverlay(overlay: SceneTextOverlay): Promise<void> {
    const fileName = overlay.sceneFileName
    if (
      fileName === '' ||
      fileName === '.' ||
      fileName === '..' ||
      fileName.includes('/') ||
      fileName.includes('\\') ||
      fileName.includes('\0') ||
      !fileName.endsWith('.txt') ||
      overlay.previewSessionId.trim() === '' ||
      !Number.isSafeInteger(overlay.editRevision) ||
      overlay.editRevision <= 0 ||
      !Number.isSafeInteger(overlay.runtimeGeneration) ||
      overlay.runtimeGeneration <= 0
    ) {
      throw new SceneOverlayUnavailable('invalid-overlay')
    }
    if (overlay.digest !== createHash('sha256').update(overlay.text, 'utf8').digest('hex')) {
      throw new SceneOverlayUnavailable('digest-mismatch')
    }
    const current = this.sceneOverlay
    if (current && current.previewSessionId !== overlay.previewSessionId) {
      throw new SceneOverlayUnavailable('foreign-session')
    }
    if (current && current.sceneFileName === overlay.sceneFileName) {
      if (overlay.editRevision < current.editRevision) {
        throw new SceneOverlayUnavailable('stale-revision')
      }
      if (overlay.runtimeGeneration < current.runtimeGeneration) {
        throw new SceneOverlayUnavailable('stale-generation')
      }
    }
    this.overlaySerial += 1
    this.sceneOverlay = { ...overlay, acceptedAt: this.overlaySerial }
  }

  async currentSceneTextOverlayRevision(scope: SceneTextOverlayScope): Promise<number> {
    const current = this.sceneOverlay
    if (!current || current.previewSessionId !== scope.previewSessionId) return 0
    if (
      scope.runtimeGeneration !== undefined &&
      current.runtimeGeneration !== scope.runtimeGeneration
    ) {
      return 0
    }
    return current.editRevision
  }

  async clearSceneTextOverlay(scope: SceneTextOverlayScope): Promise<void> {
    const current = this.sceneOverlay
    if (!current || current.previewSessionId !== scope.previewSessionId) return
    if (
      scope.runtimeGeneration !== undefined &&
      current.runtimeGeneration !== scope.runtimeGeneration
    ) {
      return
    }
    this.sceneOverlay = undefined
  }

  previewConnections(): readonly WebgalPreviewConnection[] {
    return [...this.connections]
  }
  async dispose(): Promise<void> {
    this.sceneOverlay = undefined
    for (const connection of this.connections) connection.close()
    this.connections.clear()
    const sockets = this.sockets
    const server = this.server
    this.sockets = undefined
    this.server = undefined
    this.handle = undefined
    if (sockets) {
      await new Promise<void>((resolveClose, reject) => {
        sockets.close((error) => (error ? reject(error) : resolveClose()))
      })
    }
    if (!server) return
    await new Promise<void>((resolveClose, reject) => {
      server.close((error) => (error ? reject(error) : resolveClose()))
    })
  }

  private async serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      writeText(response, 405, '运行时只允许 GET 或 HEAD')
      this.notifyRequest(pathname, 405)
      return
    }
    if (pathname === ENGINE_EXTENSION_SCRIPT_PATH) {
      this.serveEngineExtension(request, response, pathname)
      return
    }
    const safePath = safePathname(pathname)
    if (safePath === undefined) {
      writeText(response, 400, '非法运行时路径')
      this.notifyRequest(pathname, 400)
      return
    }
    const overlay =
      this.sceneOverlay && safePath === `game/scene/${this.sceneOverlay.sceneFileName}`
        ? this.sceneOverlay
        : undefined
    if (overlay) {
      const content = Buffer.from(overlay.text, 'utf8')
      response.writeHead(200, {
        'Content-Type': contentType(safePath),
        'Content-Length': String(content.byteLength),
        'Cache-Control': 'no-store'
      })
      if (request.method !== 'HEAD') response.end(content)
      else response.end()
      this.notifyRequest(pathname, 200)
      return
    }
    const resolved = await this.resolveRequestFile(safePath)
    if (!resolved) {
      writeText(response, 404, '运行时文件不存在')
      this.notifyRequest(pathname, 404)
      return
    }
    try {
      const responseContentType =
        resolved.kind === 'file' ? contentType(resolved.filePath) : resolved.contentType
      const content =
        resolved.kind === 'file'
          ? this.injectEngineExtension(safePath, await readFile(resolved.filePath))
          : Buffer.from(resolved.body, 'utf8')
      response.writeHead(200, {
        'Content-Type': responseContentType,
        'Content-Length': String(content.byteLength),
        'Cache-Control': 'no-store'
      })
      if (request.method !== 'HEAD') response.end(content)
      else response.end()
      this.notifyRequest(pathname, 200)
    } catch {
      writeText(response, 500, '运行时文件读取失败')
      this.notifyRequest(pathname, 500)
    }
  }

  private async resolveRequestFile(pathname: string): Promise<ResolvedRuntimeFile | undefined> {
    const engineDist = this.engineDist
    if (!engineDist) return undefined
    if (!pathname.startsWith('game/')) {
      const filePath = await this.resolveContainedFile(
        engineDist,
        resolve(engineDist, pathname || 'index.html')
      )
      return filePath ? { kind: 'file', filePath } : undefined
    }
    const projectRoot = this.projectRoot
    if (projectRoot) {
      for (const relativePath of projectPathsForGameRequest(pathname.slice('game/'.length))) {
        const filePath = await this.resolveContainedFile(
          projectRoot,
          resolve(projectRoot, relativePath)
        )
        if (filePath) return { kind: 'file', filePath }
      }
    }
    const defaultAsset = defaultRuntimeAssetFor(pathname)
    if (!defaultAsset) return undefined
    return {
      kind: 'default-asset',
      body: defaultAsset.body,
      contentType: defaultAsset.contentType
    }
  }

  private async resolveContainedFile(root: string, candidate: string): Promise<string | undefined> {
    if (!isInsideRoot(root, candidate)) return undefined
    try {
      const resolved = await realpath(candidate)
      if (!isInsideRoot(root, resolved)) return undefined
      const file = await stat(resolved)
      return file.isFile() ? resolved : undefined
    } catch {
      return undefined
    }
  }

  private upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    const requestedProtocols = request.headers['sec-websocket-protocol']
    const hasPreviewProtocol =
      typeof requestedProtocols === 'string' &&
      requestedProtocols
        .split(',')
        .some((protocol) => protocol.trim() === WEBGAL_COMPATIBILITY_PROFILE.previewProtocol)
    if (pathname !== WEBGAL_COMPATIBILITY_PROFILE.previewPath || !hasPreviewProtocol) {
      socket.destroy()
      return
    }
    this.sockets?.handleUpgrade(request, socket, head, (webSocket) => {
      const connection = new WsPreviewConnection(webSocket)
      this.connections.add(connection)
      connection.onClose(() => this.connections.delete(connection))
      for (const listener of this.previewListeners) listener(connection)
    })
  }

  private notifyRequest(path: string, statusCode: number): void {
    const request = { path, statusCode }
    for (const listener of this.requestListeners) listener(request)
  }

  private engineExtensionEnabled(): boolean {
    return this.options.engineExtension?.enabled !== false
  }

  private engineExtensionScriptTag(): string | undefined {
    const build = this.runtimeBuild
    if (!this.engineExtensionEnabled() || !build) return undefined
    return buildEngineExtensionScriptTag({
      engineVersion: build.engineVersion,
      supportedEngineVersions:
        this.options.engineExtension?.supportedEngineVersions ?? DEFAULT_SUPPORTED_ENGINE_VERSIONS,
      autoStart: this.options.engineExtension?.autoStart === true
    })
  }

  private injectEngineExtension(safePath: string, content: Buffer): Buffer {
    if (safePath !== '' && safePath !== 'index.html') return content
    const tag = this.engineExtensionScriptTag()
    if (!tag) return content
    const injected = injectEngineExtensionHtml(content.toString('utf8'), tag)
    return injected.injected ? Buffer.from(injected.html, 'utf8') : content
  }

  private serveEngineExtension(
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string
  ): void {
    if (!this.engineExtensionEnabled()) {
      writeText(response, 404, '引擎扩展已关闭')
      this.notifyRequest(pathname, 404)
      return
    }
    const body = Buffer.from(ENGINE_EXTENSION_SCRIPT, 'utf8')
    response.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Content-Length': String(body.byteLength),
      'Cache-Control': 'no-store'
    })
    if (request.method !== 'HEAD') response.end(body)
    else response.end()
    this.notifyRequest(pathname, 200)
  }
}
