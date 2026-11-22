import type { ParsedScene } from '@application/scenes/models/ParsedScene'
import type { PreparePreviewRuntimeRequest } from '@application/scene-preview/ports/PreviewRuntimeGateway'
import type { SceneContentBasisVO } from '@application/scene-preview/vo/ScenePreviewSessionVO'
import type { PreviewErrorVO } from '@application/scene-preview/vo/PreviewErrorVO'
import type { PreviewRuntimeListener } from '@application/scene-preview/vo/PreviewRuntimeVO'
import type {
  WebgalPreviewConnection,
  WebgalRuntimeHost
} from '@infrastructure/webgal/runtime/WebgalRuntimeHostImpl'
import type { CandidateStageFeed } from '@infrastructure/webgal/compatibility/candidateGameStart'

import { runtimeFailure } from '../previewRuntimeErrors'

export type RuntimeSession = {
  readonly previewSessionId: string
  contentBasis: SceneContentBasisVO
  runtimeGeneration: number
  sequence: number
  readonly listeners: Set<PreviewRuntimeListener>
  released: boolean
  scene: ParsedScene
  entryName: string
  readonly pendingExchanges: Set<() => void>
  packageVersion?: string
  autoStart?: boolean
  startedConnection?: WebgalPreviewConnection
  startupConnection?: WebgalPreviewConnection
  startup?: Promise<PreviewErrorVO | null>
  startupAttemptAbort?: AbortController
  startFeed?: CandidateStageFeed
  lastSnapshot?: {
    readonly connection: WebgalPreviewConnection
    readonly snapshot: StageSnapshot
  }
}

export type SessionRejection = {
  readonly failure: PreviewErrorVO
}

export type ConnectionState = {
  readonly connection: WebgalPreviewConnection
  registered: boolean
  ready: boolean
  readonly removeMessage: () => void
  readonly removeClose: () => void
}

export type ReadyWaiter = {
  readonly session: RuntimeSession
  readonly resolve: (connection: WebgalPreviewConnection | undefined) => void
}

export type StageSnapshot = {
  readonly sceneName: string
  readonly sentenceId: number
  readonly stageState?: unknown
}

export type RuntimeSnapshotSink = {
  onSnapshot(
    session: RuntimeSession,
    snapshot: StageSnapshot,
    connection: WebgalPreviewConnection
  ): void
}

export class PreviewRuntimeSessionRegistry {
  private readonly sessions = new Map<string, RuntimeSession>()
  private readonly candidateSessions = new Map<string, { readonly candidateSnapshotId: string }>()
  private readonly connections = new Map<WebgalPreviewConnection, ConnectionState>()
  private readonly readyWaiters = new Set<ReadyWaiter>()
  private readonly removeHostConnection: () => void
  private activeSessionId: string | undefined

  constructor(
    host: WebgalRuntimeHost,
    private readonly snapshots: RuntimeSnapshotSink
  ) {
    this.removeHostConnection = host.onPreviewConnection((connection) =>
      this.attachConnection(connection)
    )
    for (const connection of host.previewConnections()) this.attachConnection(connection)
  }

  session(previewSessionId: string): RuntimeSession | undefined {
    return this.sessions.get(previewSessionId)
  }

  allSessions(): Iterable<RuntimeSession> {
    return this.sessions.values()
  }

  activeSession(): RuntimeSession | undefined {
    return this.activeSessionId ? this.sessions.get(this.activeSessionId) : undefined
  }

  activate(previewSessionId: string): void {
    this.activeSessionId = previewSessionId
  }

  markReleased(session: RuntimeSession): void {
    session.released = true
  }

  forget(session: RuntimeSession): void {
    this.sessions.delete(session.previewSessionId)
    if (this.activeSessionId === session.previewSessionId) this.activeSessionId = undefined
  }

  clearSessions(): void {
    this.sessions.clear()
  }

  rememberCandidate(candidateSessionId: string, candidateSnapshotId: string): void {
    this.candidateSessions.set(candidateSessionId, { candidateSnapshotId })
  }

  forgetCandidate(candidateSessionId: string): void {
    this.candidateSessions.delete(candidateSessionId)
  }

  clearCandidates(): void {
    this.candidateSessions.clear()
  }

  openSession(request: PreparePreviewRuntimeRequest, entryName: string): RuntimeSession {
    const existing = this.sessions.get(request.previewSessionId)
    if (existing && !existing.released) {
      existing.contentBasis = request.contentBasis
      existing.runtimeGeneration = request.runtimeGeneration
      existing.scene = request.scene
      existing.entryName = entryName
      return existing
    }
    const session: RuntimeSession = {
      previewSessionId: request.previewSessionId,
      contentBasis: request.contentBasis,
      runtimeGeneration: request.runtimeGeneration,
      sequence: 0,
      listeners: new Set(),
      released: false,
      scene: request.scene,
      entryName,
      pendingExchanges: new Set()
    }
    this.sessions.set(request.previewSessionId, session)
    return session
  }

  rebaseSession(
    session: RuntimeSession,
    contentBasis: SceneContentBasisVO,
    runtimeGeneration: number,
    scene: ParsedScene,
    entryName: string
  ): void {
    session.contentBasis = contentBasis
    session.runtimeGeneration = runtimeGeneration
    session.scene = scene
    session.entryName = entryName
  }

  updateScene(session: RuntimeSession, scene: ParsedScene, entryName: string): void {
    session.scene = scene
    session.entryName = entryName
  }

  requireSession(
    previewSessionId: string,
    expectedRuntimeGeneration: number
  ): RuntimeSession | SessionRejection | undefined {
    const session = this.sessions.get(previewSessionId)
    if (!session || session.released) return undefined
    if (expectedRuntimeGeneration !== session.runtimeGeneration) {
      return { failure: runtimeFailure('staleRuntimeGeneration') }
    }
    return session
  }

  readyConnection(): WebgalPreviewConnection | undefined {
    for (const state of this.connections.values()) {
      if (state.ready) return state.connection
    }
    return undefined
  }

  addReadyWaiter(waiter: ReadyWaiter): void {
    this.readyWaiters.add(waiter)
  }

  removeReadyWaiter(waiter: ReadyWaiter): void {
    this.readyWaiters.delete(waiter)
  }

  notifyReadyWaiters(): void {
    const ready = this.readyConnection()
    for (const waiter of [...this.readyWaiters]) {
      if (waiter.session.released) {
        waiter.resolve(undefined)
        continue
      }
      if (ready) waiter.resolve(ready)
    }
  }

  resolveAllReadyWaiters(): void {
    for (const waiter of [...this.readyWaiters]) waiter.resolve(undefined)
    this.readyWaiters.clear()
  }

  detachHost(): void {
    this.removeHostConnection()
  }

  detachAllConnections(): void {
    for (const state of this.connections.values()) {
      state.removeMessage()
      state.removeClose()
    }
    this.connections.clear()
  }

  private attachConnection(connection: WebgalPreviewConnection): void {
    if (this.connections.has(connection)) return
    const removeMessage = connection.onMessage((message) => this.receive(state, message))
    const removeClose = connection.onClose(() => this.detachConnection(connection))
    const state: ConnectionState = {
      connection,
      registered: false,
      ready: false,
      removeMessage,
      removeClose
    }
    this.connections.set(connection, state)
  }

  private detachConnection(connection: WebgalPreviewConnection): void {
    const state = this.connections.get(connection)
    if (!state) return
    state.removeMessage()
    state.removeClose()
    this.connections.delete(connection)
  }

  private receive(state: ConnectionState, message: unknown): void {
    if (!message || typeof message !== 'object') return
    if (!('kind' in message) || !('type' in message)) return
    if (message.kind === 'request' && message.type === 'session.register-preview') {
      if (!('requestId' in message) || typeof message.requestId !== 'string') return
      try {
        state.connection.send({
          kind: 'response',
          type: message.type,
          requestId: message.requestId,
          payload: { sessionId: state.connection.id }
        })
        state.registered = true
      } catch {
        this.detachConnection(state.connection)
      }
      return
    }
    if (message.kind === 'event' && message.type === 'preview.ready.updated') {
      const payload = 'payload' in message ? message.payload : undefined
      const ready =
        payload && typeof payload === 'object' && 'ready' in payload ? payload.ready : undefined
      if (state.registered && ready === true) {
        state.ready = true
        this.notifyReadyWaiters()
      }
      return
    }
    if (message.kind !== 'event' || message.type !== 'stage.snapshot.updated') return
    const snapshot = readSnapshot(message)
    if (snapshot) this.forwardSnapshot(snapshot, state.connection)
  }

  private forwardSnapshot(snapshot: StageSnapshot, connection: WebgalPreviewConnection): void {
    const session = this.activeSession()
    if (!session || session.released) return
    if (!sameScene(snapshot.sceneName, session.entryName)) return
    this.snapshots.onSnapshot(session, snapshot, connection)
  }
}

export function readSnapshot(message: unknown): StageSnapshot | undefined {
  if (!message || typeof message !== 'object') return undefined
  if (!('kind' in message) || message.kind !== 'event') return undefined
  if (!('type' in message) || message.type !== 'stage.snapshot.updated') return undefined
  if (!('payload' in message)) return undefined
  const payload = message.payload
  if (!payload || typeof payload !== 'object') return undefined
  if (!('sceneName' in payload) || typeof payload.sceneName !== 'string') return undefined
  if (!('sentenceId' in payload) || typeof payload.sentenceId !== 'number') return undefined
  return {
    sceneName: payload.sceneName,
    sentenceId: payload.sentenceId,
    stageState: 'stageState' in payload ? payload.stageState : undefined
  }
}

export function sceneIdentity(name: string): string {
  const normalized = name.replaceAll('\\', '/')
  const fileName = normalized.slice(normalized.lastIndexOf('/') + 1)
  return fileName.replace(/\.txt$/u, '')
}

export function sameScene(left: string, right: string): boolean {
  return sceneIdentity(left) === sceneIdentity(right)
}
