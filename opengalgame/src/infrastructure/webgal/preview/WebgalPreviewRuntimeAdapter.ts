import { basename } from 'node:path'

import type { ParsedScene, SceneSourceRange } from '@application/scenes/models/ParsedScene'
import type {
  WebgalPreviewConnection,
  WebgalRuntimeHost
} from '@infrastructure/webgal/runtime/WebgalRuntimeHostImpl'
import { WebgalInfrastructureError } from '@infrastructure/webgal/WebgalInfrastructureError'

export type PreviewFailureKind =
  | 'not-ready'
  | 'incompatible'
  | 'content-changed'
  | 'timeout'
  | 'no-progress'
  | 'runtime-error'
  | 'disconnected'
  | 'cancelled'
  | 'stale-response'

export interface ScenePreviewTarget {
  readonly sceneFile: string
  readonly sentenceSequence: number
  readonly contentDigest: string
  readonly sourceRange: SceneSourceRange
}

export interface ScenePreviewStageSnapshot {
  readonly sceneFile: string
  readonly sentenceSequence: number
  readonly contentDigest: string
  readonly stageState: unknown
}

export interface ScenePreviewEffect {
  readonly target: string
  readonly phase: 'preview' | 'commit'
  readonly transform: unknown
}

export interface ScenePreviewResult {
  readonly status: 'located' | 'failed'
  readonly target?: ScenePreviewTarget
  readonly snapshot?: ScenePreviewStageSnapshot
  readonly failure?: { readonly kind: PreviewFailureKind; readonly message: string }
}

type ProtocolKind = 'event' | 'request' | 'response' | 'error'

type ProtocolEnvelope = {
  readonly kind: ProtocolKind
  readonly type: string
  readonly requestId?: string
  readonly payload?: unknown
  readonly error?: { readonly code: string; readonly message?: string }
}

type PendingResponse = {
  readonly connection: WebgalPreviewConnection
  readonly resolve: (payload: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
  readonly removeAbort?: () => void
}

type SnapshotWaiter = {
  readonly connection: WebgalPreviewConnection
  readonly sceneName: string
  readonly sentenceId: number | undefined
  readonly minimum: boolean
  readonly resolve: (snapshot: StageSnapshot) => void
  readonly reject: (error: Error) => void
  readonly cleanup: () => void
}

type ConnectionWaiter = {
  readonly resolve: (connection: WebgalPreviewConnection) => void
  readonly reject: (error: Error) => void
  readonly cleanup: () => void
}

type ReadyWaiter = {
  readonly resolve: () => void
  readonly reject: (error: Error) => void
  readonly cleanup: () => void
}

type StageSnapshot = {
  readonly sceneName: string
  readonly sentenceId: number
  readonly stageState: unknown
}

type ActiveOperation = {
  readonly controller: AbortController
}

const supportedCommandTypes = new Set([
  'preview.command.sync-scene',
  'preview.command.run-scene-content',
  'preview.command.run-snippet',
  'preview.command.reload-templates',
  'preview.command.set-effect',
  'preview.command.set-component-visibility',
  'preview.command.set-font-optimization',
  'preview.command.set-text-read-mode'
])

function isProtocolEnvelope(value: unknown): value is ProtocolEnvelope {
  if (!value || typeof value !== 'object') return false
  const envelope = value as Record<string, unknown>
  if (!['event', 'request', 'response', 'error'].includes(String(envelope.kind))) return false
  if (
    typeof envelope.type !== 'string' ||
    (typeof envelope.payload === 'undefined' && envelope.kind !== 'error')
  )
    return false
  if (
    (envelope.kind === 'request' || envelope.kind === 'response' || envelope.kind === 'error') &&
    typeof envelope.requestId !== 'string'
  ) {
    return false
  }
  if (envelope.kind === 'error') {
    const error = envelope.error
    if (
      !error ||
      typeof error !== 'object' ||
      typeof (error as Record<string, unknown>).code !== 'string'
    )
      return false
  }
  return true
}

function requestId(): string {
  return `req-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function sceneName(scene: ParsedScene): string {
  return basename(scene.sourceFile.relativePath.replaceAll('\\', '/'))
}

function cancellationError(signal: AbortSignal): WebgalInfrastructureError {
  const reason = signal.reason as { kind?: string } | undefined
  if (reason?.kind === 'stale-response') {
    return new WebgalInfrastructureError('preview-stale', '预览响应已过期，当前请求已取代旧请求')
  }
  return new WebgalInfrastructureError('preview-cancelled', '预览请求已取消')
}

function errorForFailure(error: unknown): { kind: PreviewFailureKind; message: string } {
  if (error instanceof WebgalInfrastructureError) {
    const kinds: Partial<Record<WebgalInfrastructureError['kind'], PreviewFailureKind>> = {
      'preview-timeout': 'timeout',
      'preview-not-ready': 'not-ready',
      'preview-no-progress': 'no-progress',
      'preview-cancelled': 'cancelled',
      'preview-stale': 'stale-response',
      'preview-disconnected': 'disconnected',
      'incompatible-runtime': 'incompatible',
      'inconsistent-read': 'content-changed',
      'runtime-error': 'runtime-error'
    }
    return { kind: kinds[error.kind] ?? 'runtime-error', message: error.message }
  }
  return {
    kind: 'runtime-error',
    message: error instanceof Error ? error.message : 'WebGAL 预览失败'
  }
}

export interface WebgalPreviewRuntimeAdapterOptions {
  readonly host: WebgalRuntimeHost
  readonly gameId?: string
  readonly embeddedLaunchId?: string
  readonly timeoutMs?: number
}

export class WebgalPreviewRuntimeAdapter {
  private readonly timeoutMs: number
  private readonly pending = new Map<string, PendingResponse>()
  private readonly snapshotWaiters = new Set<SnapshotWaiter>()
  private connection: WebgalPreviewConnection | undefined
  private removeConnectionMessage: (() => void) | undefined
  private removeConnectionClose: (() => void) | undefined
  private removeHostConnection: () => void
  private activeOperation: ActiveOperation | undefined
  private registered = false
  private ready = false
  private disposed = false
  private connectionWaiters: ConnectionWaiter[] = []
  private readyWaiters: ReadyWaiter[] = []
  private registrationWaiters: ReadyWaiter[] = []
  private readonly stageListeners = new Set<(snapshot: StageSnapshot) => void>()
  private readonly sentCommandListeners = new Set<(command: string) => void>()

  constructor(private readonly options: WebgalPreviewRuntimeAdapterOptions) {
    this.timeoutMs = options.timeoutMs ?? 5000
    this.removeHostConnection = options.host.onPreviewConnection((connection) =>
      this.attachConnection(connection)
    )
  }

  onStageSnapshot(listener: (snapshot: StageSnapshot) => void): () => void {
    this.stageListeners.add(listener)
    return () => {
      this.stageListeners.delete(listener)
    }
  }

  onSentCommand(listener: (command: string) => void): () => void {
    this.sentCommandListeners.add(listener)
    return () => {
      this.sentCommandListeners.delete(listener)
    }
  }

  async awaitSceneSnapshot(
    expectedSceneName: string,
    signal?: AbortSignal
  ): Promise<{ readonly sceneName: string; readonly sentenceId: number }> {
    const sceneName = expectedSceneName.trim()
    if (sceneName === '') {
      throw new WebgalInfrastructureError('preview-protocol', '候选预览入口无效')
    }
    return this.withOperation(signal, async (operationSignal) => {
      const connection = await this.waitForConnection(operationSignal, 12_000)
      await this.waitForRegistered(operationSignal)
      const snapshot = await this.waitForSnapshot(
        connection,
        '',
        undefined,
        operationSignal,
        12_000
      )
      return { sceneName: snapshot.sceneName, sentenceId: snapshot.sentenceId }
    })
  }

  async syncScene(
    scene: ParsedScene,
    target: ScenePreviewTarget,
    signal?: AbortSignal
  ): Promise<ScenePreviewResult> {
    if (target.contentDigest !== scene.contentDigest) {
      return {
        status: 'failed',
        target,
        failure: { kind: 'content-changed', message: '场景内容摘要已变化，旧定位已失效' }
      }
    }
    try {
      return await this.withOperation(signal, async (operationSignal) => {
        const connection = await this.waitUntilReady(operationSignal)
        const expectedSceneName = sceneName(scene)
        const stopSentenceId = this.engineSentenceId(scene, target) + 1
        const snapshot = this.waitForSnapshot(
          connection,
          expectedSceneName,
          stopSentenceId,
          operationSignal,
          this.timeoutMs,
          true
        )
        await this.sendRequest(
          connection,
          'preview.command.sync-scene',
          {
            sceneName: expectedSceneName,
            sentenceId: stopSentenceId,
            debugVariables: [],
            settleMode: 'normal'
          },
          operationSignal
        )
        const stage = await snapshot
        return {
          status: 'located',
          target,
          snapshot: {
            sceneFile: target.sceneFile,
            sentenceSequence: target.sentenceSequence,
            contentDigest: target.contentDigest,
            stageState: stage.stageState
          }
        }
      })
    } catch (error) {
      return { status: 'failed', target, failure: errorForFailure(error) }
    }
  }

  async runSceneContent(
    scene: ParsedScene,
    contentDigest: string,
    signal?: AbortSignal
  ): Promise<void> {
    if (contentDigest !== scene.contentDigest)
      throw new WebgalInfrastructureError('inconsistent-read', '场景内容摘要已变化')
    await this.runCommand(
      'preview.command.run-scene-content',
      { sceneContent: scene.sourceFile.text ?? '', debugVariables: [], contentDigest },
      signal
    )
  }

  async runSnippet(content: string, contentDigest: string, signal?: AbortSignal): Promise<void> {
    await this.runCommand(
      'preview.command.run-snippet',
      { snippet: content, debugVariables: [], contentDigest },
      signal
    )
  }

  async reloadTemplates(signal?: AbortSignal): Promise<void> {
    await this.runCommand('preview.command.reload-templates', {}, signal)
  }

  async setEffect(effect: ScenePreviewEffect, signal?: AbortSignal): Promise<void> {
    await this.runCommand('preview.command.set-effect', effect, signal)
  }

  async setComponentVisibility(
    visibility: Readonly<Record<string, boolean>>,
    signal?: AbortSignal
  ): Promise<void> {
    await this.runCommand('preview.command.set-component-visibility', visibility, signal)
  }

  async setFontOptimization(enabled: boolean, signal?: AbortSignal): Promise<void> {
    await this.runCommand('preview.command.set-font-optimization', { enabled }, signal)
  }

  async setTextReadMode(enabled: boolean, signal?: AbortSignal): Promise<void> {
    await this.runCommand('preview.command.set-text-read-mode', { isRead: enabled }, signal)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const cancellation = new WebgalInfrastructureError('preview-cancelled', '预览会话已销毁')
    this.activeOperation?.controller.abort(
      new WebgalInfrastructureError('preview-cancelled', '预览会话已销毁')
    )
    this.removeHostConnection()
    const connection = this.connection
    this.detachConnection('preview disposed')
    connection?.close()
    for (const waiter of this.connectionWaiters.splice(0)) waiter.reject(cancellation)
    for (const waiter of this.readyWaiters.splice(0)) waiter.reject(cancellation)
    for (const waiter of [...this.snapshotWaiters]) waiter.reject(cancellation)
    this.stageListeners.clear()
    this.sentCommandListeners.clear()
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.removeAbort?.()
      pending.reject(cancellation)
      this.pending.delete(id)
    }
  }

  private async runCommand(type: string, payload: unknown, signal?: AbortSignal): Promise<void> {
    await this.withOperation(signal, async (operationSignal) => {
      const connection = await this.waitUntilReady(operationSignal)
      await this.sendRequest(
        connection,
        type,
        { ...(payload as Record<string, unknown>), sessionId: connection.id },
        operationSignal
      )
    })
  }

  private async withOperation<T>(
    signal: AbortSignal | undefined,
    action: (operationSignal: AbortSignal) => Promise<T>
  ): Promise<T> {
    if (this.disposed) throw new WebgalInfrastructureError('preview-cancelled', '预览会话已销毁')
    if (signal?.aborted) throw cancellationError(signal)
    this.activeOperation?.controller.abort({ kind: 'stale-response' })
    const controller = new AbortController()
    const operation: ActiveOperation = { controller }
    this.activeOperation = operation
    const abort = (): void => controller.abort(signal?.reason)
    signal?.addEventListener('abort', abort, { once: true })
    try {
      return await action(controller.signal)
    } catch (error) {
      if (controller.signal.aborted) throw cancellationError(controller.signal)
      throw error
    } finally {
      signal?.removeEventListener('abort', abort)
      if (this.activeOperation === operation) this.activeOperation = undefined
    }
  }

  private async waitUntilReady(signal: AbortSignal): Promise<WebgalPreviewConnection> {
    if (this.disposed) throw new WebgalInfrastructureError('preview-cancelled', '预览会话已销毁')
    const connection = await this.waitForConnection(signal)
    if (this.disposed) throw new WebgalInfrastructureError('preview-cancelled', '预览会话已销毁')
    if (this.connection !== connection)
      throw new WebgalInfrastructureError('preview-disconnected', 'WebGAL 预览连接已替换')
    if (this.ready) return connection
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const abort = (): void => {
        if (settled) return
        settled = true
        this.readyWaiters = this.readyWaiters.filter((item) => item !== waiter)
        waiter.cleanup()
        reject(cancellationError(signal))
      }
      const waiter: ReadyWaiter = {
        resolve: () => {
          if (settled) return
          settled = true
          waiter.cleanup()
          resolve()
        },
        reject: (error) => {
          if (settled) return
          settled = true
          waiter.cleanup()
          reject(error)
        },
        cleanup: () => signal.removeEventListener('abort', abort)
      }
      this.readyWaiters.push(waiter)
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    })
    return connection
  }

  private waitForRegistered(signal: AbortSignal): Promise<void> {
    if (this.registered) return Promise.resolve()
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    const timer = setTimeout(() => {
      stop()
      reject(new WebgalInfrastructureError('preview-not-ready', 'WebGAL 预览尚未注册'))
    }, 12_000)
    const abort = (): void => {
      stop()
      reject(cancellationError(signal))
    }
    const stop = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      this.registrationWaiters = this.registrationWaiters.filter((item) => item !== waiter)
    }
    const waiter: ReadyWaiter = {
      resolve: () => {
        stop()
        resolve()
      },
      reject: (error) => {
        stop()
        reject(error)
      },
      cleanup: stop
    }
    this.registrationWaiters.push(waiter)
    if (this.registered) {
      stop()
      resolve()
    } else if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    return promise
  }

  private waitForConnection(
    signal: AbortSignal,
    timeoutMs = this.timeoutMs
  ): Promise<WebgalPreviewConnection> {
    if (this.disposed)
      return Promise.reject(new WebgalInfrastructureError('preview-cancelled', '预览会话已销毁'))
    if (this.connection) return Promise.resolve(this.connection)
    return new Promise<WebgalPreviewConnection>((resolve, reject) => {
      let settled = false
      const abort = (): void => {
        if (settled) return
        settled = true
        this.connectionWaiters = this.connectionWaiters.filter((item) => item !== waiter)
        waiter.cleanup()
        reject(cancellationError(signal))
      }
      const waiter: ConnectionWaiter = {
        resolve: (connection) => {
          if (settled) return
          settled = true
          waiter.cleanup()
          resolve(connection)
        },
        reject: (error) => {
          if (settled) return
          settled = true
          waiter.cleanup()
          reject(error)
        },
        cleanup: () => {
          clearTimeout(timer)
          signal.removeEventListener('abort', abort)
        }
      }
      this.connectionWaiters.push(waiter)
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        this.connectionWaiters = this.connectionWaiters.filter((item) => item !== waiter)
        waiter.cleanup()
        reject(new WebgalInfrastructureError('preview-not-ready', 'WebGAL 预览尚未就绪'))
      }, timeoutMs)
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    })
  }

  private sendRequest(
    connection: WebgalPreviewConnection,
    type: string,
    payload: unknown,
    signal: AbortSignal
  ): Promise<unknown> {
    if (!supportedCommandTypes.has(type)) {
      throw new WebgalInfrastructureError('preview-protocol', `不支持的 WebGAL 预览命令：${type}`)
    }
    if (this.disposed) throw new WebgalInfrastructureError('preview-cancelled', '预览会话已销毁')
    if (connection !== this.connection)
      throw new WebgalInfrastructureError('preview-disconnected', 'WebGAL 预览连接已替换')
    const id = requestId()
    return new Promise((resolve, reject) => {
      let settled = false
      const cleanup = (): void => {
        clearTimeout(timer)
        this.pending.delete(id)
        signal.removeEventListener('abort', abort)
      }
      const abort = (): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(cancellationError(signal))
      }
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        cleanup()
        reject(new WebgalInfrastructureError('preview-timeout', `WebGAL 预览命令超时：${type}`))
      }, this.timeoutMs)
      if (signal.aborted) {
        clearTimeout(timer)
        reject(cancellationError(signal))
        return
      }
      signal.addEventListener('abort', abort, { once: true })
      this.pending.set(id, {
        connection,
        resolve,
        reject,
        timer,
        removeAbort: () => signal.removeEventListener('abort', abort)
      })
      try {
        connection.send({ kind: 'request', type, requestId: id, payload })
        for (const listener of this.sentCommandListeners) listener(type)
      } catch (error) {
        if (!settled) {
          settled = true
          cleanup()
          reject(error instanceof Error ? error : new Error('无法发送 WebGAL 预览命令'))
        }
      }
    })
  }

  private waitForSnapshot(
    connection: WebgalPreviewConnection,
    expectedSceneName: string,
    sentenceId: number | undefined,
    signal: AbortSignal,
    timeoutMs = this.timeoutMs,
    minimum = false
  ): Promise<StageSnapshot> {
    if (this.disposed)
      return Promise.reject(new WebgalInfrastructureError('preview-cancelled', '预览会话已销毁'))
    if (connection !== this.connection)
      return Promise.reject(
        new WebgalInfrastructureError('preview-disconnected', 'WebGAL 预览连接已替换')
      )
    return new Promise((resolve, reject) => {
      let settled = false
      if (signal.aborted) {
        reject(cancellationError(signal))
        return
      }
      const abort = (): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(cancellationError(signal))
      }
      const cleanup = (): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        this.snapshotWaiters.delete(waiter)
      }
      const waiter: SnapshotWaiter = {
        connection,
        sceneName: expectedSceneName,
        sentenceId,
        minimum,
        resolve: (snapshot) => {
          if (settled) return
          settled = true
          cleanup()
          resolve(snapshot)
        },
        reject: (error) => {
          if (settled) return
          settled = true
          cleanup()
          reject(error)
        },
        cleanup
      }
      this.snapshotWaiters.add(waiter)
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        cleanup()
        reject(new WebgalInfrastructureError('preview-timeout', '等待 WebGAL 舞台状态超时'))
      }, timeoutMs)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  }

  private engineSentenceId(scene: ParsedScene, target: ScenePreviewTarget): number {
    const sentence = scene.sentences.find((item) => item.sequence === target.sentenceSequence)
    if (!sentence)
      throw new WebgalInfrastructureError('inconsistent-read', '目标语句不属于当前场景内容')
    return sentence.engineSentenceIndex
  }

  private attachConnection(connection: WebgalPreviewConnection): void {
    if (this.disposed) {
      connection.close()
      return
    }
    this.detachConnection('new preview connection')
    this.connection = connection
    this.registered = false
    this.ready = false
    this.removeConnectionMessage = connection.onMessage((message) =>
      this.receive(connection, message)
    )
    this.removeConnectionClose = connection.onClose((reason) =>
      this.detachConnection(reason ?? 'preview disconnected')
    )
    for (const waiter of this.connectionWaiters.splice(0)) waiter.resolve(connection)
  }

  private detachConnection(reason: string): void {
    this.removeConnectionMessage?.()
    this.removeConnectionClose?.()
    this.removeConnectionMessage = undefined
    this.removeConnectionClose = undefined
    const previous = this.connection
    this.connection = undefined
    this.registered = false
    this.ready = false
    if (previous) {
      for (const [id, pending] of this.pending) {
        if (pending.connection !== previous) continue
        clearTimeout(pending.timer)
        pending.removeAbort?.()
        pending.reject(
          new WebgalInfrastructureError('preview-disconnected', `WebGAL 预览连接已断开：${reason}`)
        )
        this.pending.delete(id)
      }
      for (const waiter of [...this.snapshotWaiters]) {
        if (waiter.connection !== previous) continue
        waiter.reject(
          new WebgalInfrastructureError(
            'preview-disconnected',
            `WebGAL 舞台状态连接已断开：${reason}`
          )
        )
      }
    }
    for (const waiter of this.readyWaiters.splice(0))
      waiter.reject(new WebgalInfrastructureError('preview-disconnected', 'WebGAL 预览未就绪'))
  }

  private receive(connection: WebgalPreviewConnection, value: unknown): void {
    if (connection !== this.connection || !isProtocolEnvelope(value)) return
    if (value.kind === 'request' && value.type === 'session.register-preview') {
      try {
        connection.send({
          kind: 'response',
          type: value.type,
          requestId: value.requestId,
          payload: {
            gameId: this.options.gameId,
            embeddedLaunchId: this.options.embeddedLaunchId,
            sessionId: connection.id
          }
        })
        this.registered = true
        for (const waiter of this.registrationWaiters.splice(0)) waiter.resolve()
      } catch {
        this.detachConnection('无法回复注册请求')
      }
      return
    }
    if (value.kind === 'event' && value.type === 'preview.ready.updated') {
      const ready = value.payload as { ready?: unknown } | undefined
      if (this.registered && ready?.ready === true) {
        this.ready = true
        for (const waiter of this.readyWaiters.splice(0)) waiter.resolve()
      }
      return
    }
    if (value.kind === 'event' && value.type === 'preview.event.fast-preview-timeout') {
      for (const waiter of [...this.snapshotWaiters]) {
        if (waiter.connection !== connection) continue
        waiter.reject(
          new WebgalInfrastructureError('preview-no-progress', 'WebGAL 快速预览没有到达目标')
        )
      }
      return
    }
    if (value.kind === 'event' && value.type === 'stage.snapshot.updated') {
      const payload = value.payload as
        { sceneName?: unknown; sentenceId?: unknown; stageState?: unknown } | undefined
      if (typeof payload?.sceneName !== 'string' || typeof payload.sentenceId !== 'number') return
      const snapshot: StageSnapshot = {
        sceneName: payload.sceneName,
        sentenceId: payload.sentenceId,
        stageState: payload.stageState
      }
      for (const listener of this.stageListeners) listener(snapshot)
      for (const waiter of [...this.snapshotWaiters]) {
        if (
          waiter.connection !== connection ||
          (waiter.sceneName !== '' &&
            sceneLabel(waiter.sceneName) !== sceneLabel(snapshot.sceneName)) ||
          (waiter.sentenceId !== undefined &&
            (waiter.minimum
              ? snapshot.sentenceId < waiter.sentenceId
              : snapshot.sentenceId !== waiter.sentenceId))
        )
          continue
        waiter.resolve(snapshot)
      }
      return
    }
    if ((value.kind === 'response' || value.kind === 'error') && value.requestId) {
      const pending = this.pending.get(value.requestId)
      if (!pending || pending.connection !== connection) return
      this.pending.delete(value.requestId)
      clearTimeout(pending.timer)
      pending.removeAbort?.()
      if (value.kind === 'error') {
        pending.reject(
          new WebgalInfrastructureError(
            'runtime-error',
            value.error?.message ?? `WebGAL 预览命令失败：${value.type}`
          )
        )
      } else pending.resolve(value.payload)
    }
  }
}

function sceneLabel(sceneName: string): string {
  return sceneName.replace(/\.txt$/u, '')
}
