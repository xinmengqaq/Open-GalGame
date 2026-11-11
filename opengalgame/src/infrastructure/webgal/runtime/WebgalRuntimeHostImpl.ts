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
import { serveBrowserStageInput } from '@infrastructure/webgal/compatibility/BrowserStageTrustedInput'
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
  /**
   * @throws 连接已关闭时抛出错误。
   */
  send(message: unknown): void
  /**
   * @returns 取消订阅函数。
   */
  onMessage(listener: (message: unknown) => void): () => void
  /**
   * @returns 取消订阅函数。
   */
  onClose(listener: (reason?: string) => void): () => void
  close(): void
}

export interface WebgalRuntimeHandle {
  readonly baseUrl: string
  readonly previewUrl: string
  readonly port: number
  readonly build: WebgalRuntimeBuildEvidence
}

export interface WebgalRuntimeHost {
  /**
   * @throws 端口监听或兼容性校验失败时抛出错误。
   */
  start(): Promise<WebgalRuntimeHandle>
  /**
   * @returns 取消订阅函数。
   */
  onPreviewConnection(listener: (connection: WebgalPreviewConnection) => void): () => void
  /**
   * @returns 取消订阅函数。
   */
  onRequest(listener: (request: WebgalRuntimeRequest) => void): () => void
  /**
   * @returns 已启动时的句柄；未启动时为 undefined。
   */
  getHandle(): WebgalRuntimeHandle | undefined
  /**
   * 把已校验的正式工程根绑定到当前宿主。
   * 越界、不存在或不是目录时拒绝，错误不含路径。
   */
  useProjectRoot(projectRoot: string): Promise<void>
  /**
   * 只覆盖当前会话的场景入口文本。
   * 旧修订、错属会话和摘要不一致时拒绝，不写磁盘。
   */
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
  /**
   * 自制引擎扩展：默认启用，向引擎页面注入脚本并保留 `/figure/` 立绘纹理。
   * 显式 `{ enabled: false }` 时不注入，扩展路由返回 404。
   */
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

/** 场景覆盖被宿主拒绝。消息保持稳定，原因交给网关映射成预览失败码。 */
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

/**
 * @returns HTTP 内容类型；未知扩展名回退为二进制流。
 */
function contentType(path: string): string {
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  return contentTypes[extension] ?? 'application/octet-stream'
}

/**
 * 校验并按需解码请求路径，拒绝空字节、反斜杠和向上跨越的片段。
 * @returns 去掉前导斜杠的相对路径；非法时为 undefined。
 */
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

/** 输出纯文本响应，运行时不缓存任何内容。 */
function writeText(response: ServerResponse, statusCode: number, body: string): void {
  response.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  response.end(body)
}

/** 请求命中的磁盘文件，或工程缺失时按精确路径提供的运行时默认资源。 */
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

  /** 序列化后发送，连接不可用时抛出。 */
  send(message: unknown): void {
    if (this.closed || this.socket.readyState !== this.socket.OPEN) {
      throw new Error('WebGAL 预览连接已关闭')
    }
    this.socket.send(JSON.stringify(message))
  }

  /** 订阅协议消息，返回取消订阅函数。 */
  onMessage(listener: (message: unknown) => void): () => void {
    this.messageListeners.add(listener)
    return () => this.messageListeners.delete(listener)
  }

  /** 订阅连接关闭，返回取消订阅函数。 */
  onClose(listener: (reason?: string) => void): () => void {
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }

  close(): void {
    if (this.closed) return
    this.socket.close()
    this.finish('closed by host')
  }

  /** 统一收尾：向关闭监听器广播一次原因，随后清空监听器。 */
  private finish(reason?: string): void {
    if (this.closed) return
    this.closed = true
    for (const listener of this.closeListeners) listener(reason)
    this.messageListeners.clear()
    this.closeListeners.clear()
  }
}

/**
 * 承载固定 WebGAL dist，并把工程文件只读映射到引擎的 `game/` 路径。
 * 当前会话可以在磁盘解析前覆盖一个场景入口，覆盖不写作品源。
 * 4.6.5 构建主动连接 `/api/webgalsync`，所以这里用 `ws` 应答，不自写帧解析。
 */
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

  /** 启动 HTTP 与 WebSocket 服务，并装配预览协议端点。 */
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
      build
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

  /** 处理一次静态资源请求，只读放行工程素材与运行时构建文件。 */
  private async serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (serveBrowserStageInput(request, response)) {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      this.notifyRequest(pathname, response.statusCode)
      return
    }
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

  /**
   * 把请求路径映射到磁盘文件：`game/` 走工程素材候选，其余走运行时构建目录。
   * 工程内文件永远优先；`game/` 文件缺失时只对精确命中的可选文件回落默认资源。
   * @returns 命中的文件或默认资源；都不存在时为 undefined。
   */
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

  /**
   * 解析并确认文件仍在根目录内，拒绝符号链接越界。
   * @param root - 允许的根目录。
   * @returns 命中的普通文件路径；越界或不存在时为 undefined。
   */
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

  /** 校验 WebSocket 子协议与路径后升级连接，其余升级请求直接拒绝。 */
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

  /** @returns 引擎扩展是否启用；缺省启用。 */
  private engineExtensionEnabled(): boolean {
    return this.options.engineExtension?.enabled !== false
  }

  /**
   * @returns 需要注入引擎页面的脚本标签；扩展关闭或运行时尚未就绪时为 undefined。
   */
  private engineExtensionScriptTag(): string | undefined {
    const build = this.runtimeBuild
    if (!this.engineExtensionEnabled() || !build) return undefined
    return buildEngineExtensionScriptTag({
      engineVersion: build.engineVersion,
      supportedEngineVersions:
        this.options.engineExtension?.supportedEngineVersions ?? DEFAULT_SUPPORTED_ENGINE_VERSIONS
    })
  }

  /**
   * 只在引擎入口 HTML 上注入扩展脚本，其余静态文件原样返回。
   * @param safePath - 已解码、去掉前导斜杠的请求路径。
   * @param content - 磁盘上的入口内容。
   * @returns 注入后的内容；未注入时返回原 Buffer。
   */
  private injectEngineExtension(safePath: string, content: Buffer): Buffer {
    if (safePath !== '' && safePath !== 'index.html') return content
    const tag = this.engineExtensionScriptTag()
    if (!tag) return content
    const injected = injectEngineExtensionHtml(content.toString('utf8'), tag)
    return injected.injected ? Buffer.from(injected.html, 'utf8') : content
  }

  /** 提供扩展脚本，并记录请求；关闭扩展时按不存在处理。 */
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
