import { basename } from 'node:path'
import type { ParsedScene, ParsedSceneSentence } from '@application/scenes/models/ParsedScene'
import type {
  PlayPreviewDialogueRequest,
  PreparePreviewRuntimeRequest,
  PreviewRuntimeGateway,
  RebasePreviewRuntimeRequest,
  SceneTextOverlayRequest,
  SceneTextOverlayScope
} from '@application/scene-preview/ports/PreviewRuntimeGateway'
import { SceneOverlayRejected } from '@application/scene-preview/ports/PreviewRuntimeGateway'
import type { PreviewSessionRef } from '@application/scene-preview/dto/PreviewPlaybackDTO'
import type { SceneContentBasisVO } from '@application/scene-preview/vo/ScenePreviewSessionVO'
import type {
  PreviewCommandResultVO,
  PreviewPhase,
  PreviewPositionVO,
  PreviewRuntimeListener,
  PreviewStageResultVO,
  PreviewStageVO
} from '@application/scene-preview/vo/PreviewRuntimeVO'
import type { PreviewErrorVO } from '@application/scene-preview/vo/PreviewErrorVO'
import {
  SceneOverlayUnavailable,
  type SceneOverlayUnavailableReason,
  type WebgalPreviewConnection,
  type WebgalRuntimeHandle,
  type WebgalRuntimeHost
} from '@infrastructure/webgal/runtime/WebgalRuntimeHostImpl'
import {
  CandidateStageFeed,
  CandidateStartError,
  confirmCandidateGame,
  selectCandidateStartSupport,
  type CandidateTrustedInput,
  type CandidateTrustedInputSource
} from '@infrastructure/webgal/compatibility/candidateGameStart'
import { WEBGAL_COMPATIBILITY_PROFILE } from '@infrastructure/webgal/compatibility/WebgalCompatibilityProfile'
import { WebgalPreviewControlBridge } from '@infrastructure/webgal/preview/WebgalPreviewControlBridge'

import { runtimeFailure } from './previewRuntimeErrors'

type RuntimeSession = {
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
  trustedInput?: CandidateTrustedInput
  trustedInputAbort?: AbortController
  stagePageUrl?: string
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

type SessionRejection = {
  readonly failure: PreviewErrorVO
}

type ConnectionState = {
  readonly connection: WebgalPreviewConnection
  registered: boolean
  ready: boolean
  readonly removeMessage: () => void
  readonly removeClose: () => void
}

type ReadyWaiter = {
  readonly session: RuntimeSession
  readonly resolve: (connection: WebgalPreviewConnection | undefined) => void
}

export type PreviewRuntimeGatewayOptions = {
  readonly host: WebgalRuntimeHost
  readonly bridge: WebgalPreviewControlBridge
  readonly timeoutMs?: number
  /** 版本化宿主兼容输入；提供时先把语言和标题层处理成真实游戏，再允许定位。 */
  readonly trustedInput?: CandidateTrustedInputSource
  readonly startupTimeoutMs?: number
}

export type CandidateRuntimeRequest = {
  readonly candidateSessionId: string
  readonly candidateSnapshotId: string
  readonly projectRoot: string
  readonly entryFile: string
}

type StageSnapshot = {
  readonly sceneName: string
  readonly sentenceId: number
  readonly stageState?: unknown
}

type ExchangeResult =
  | { readonly status: 'snapshot'; readonly snapshot: StageSnapshot }
  | { readonly status: 'timeout'; readonly timedOut: boolean; readonly snapshot?: StageSnapshot }
  | { readonly status: 'rejected' }

/**
 * 当前场景预览运行时。
 * 准备只返回宿主给出的可嵌入地址；真实注册、就绪和舞台快照由引擎消息确认。
 * sync-scene 只证明台词已定位，舞台快照没有播放阶段，不能报暂停或播放。
 */
export class PreviewRuntimeGatewayImpl implements PreviewRuntimeGateway {
  private readonly sessions = new Map<string, RuntimeSession>()
  private readonly candidateSessions = new Map<string, { readonly candidateSnapshotId: string }>()
  private readonly connections = new Map<WebgalPreviewConnection, ConnectionState>()
  private readonly readyWaiters = new Set<ReadyWaiter>()
  private readonly removeHostConnection: () => void
  private sceneOverlay: SceneTextOverlayRequest | undefined
  private activeSessionId: string | undefined
  private readonly timeoutMs: number
  private readonly startupTimeoutMs: number

  constructor(private readonly options: PreviewRuntimeGatewayOptions) {
    this.timeoutMs = options.timeoutMs ?? 5_000
    this.startupTimeoutMs = options.startupTimeoutMs ?? 20_000
    this.removeHostConnection = options.host.onPreviewConnection((connection) =>
      this.attachConnection(connection)
    )
    for (const connection of options.host.previewConnections()) this.attachConnection(connection)
  }

  async prepare(request: PreparePreviewRuntimeRequest): Promise<PreviewStageResultVO> {
    if (!dialogueSentence(request.scene, request.dialogueId)) {
      return { status: 'failed', failure: runtimeFailure('prepareFailed') }
    }
    const root = await this.bindProject(request)
    if (!root) return { status: 'failed', failure: runtimeFailure('prepareFailed') }
    let handle
    try {
      handle = await this.options.host.start()
    } catch {
      return { status: 'failed', failure: runtimeFailure('prepareFailed') }
    }
    if (!handle) return { status: 'failed', failure: runtimeFailure('prepareFailed') }
    const previous = this.sessions.get(request.previewSessionId)
    if (
      previous &&
      !previous.released &&
      (previous.runtimeGeneration !== request.runtimeGeneration ||
        !sameBasis(previous.contentBasis, request.contentBasis) ||
        !sameScene(previous.entryName, root.entryName))
    ) {
      this.cancelExchanges(previous)
      this.sceneOverlay = undefined
      await this.options.host.clearSceneTextOverlay({
        previewSessionId: request.previewSessionId
      })
    }
    const session = this.openSession(request, root.entryName)
    if (session.released) return { status: 'failed', failure: runtimeFailure('prepareFailed') }
    this.activeSessionId = session.previewSessionId
    session.sequence = 1
    this.resetStartup(session, handle)
    const stage: PreviewStageVO = {
      previewSessionId: session.previewSessionId,
      contentBasis: session.contentBasis,
      runtimeGeneration: session.runtimeGeneration,
      sequence: session.sequence,
      phase: 'unknown',
      position: { kind: 'unknown' }
    }
    return {
      status: 'ready',
      stageUrl: session.stagePageUrl ?? `${handle.baseUrl}/index.html`,
      stage
    }
  }

  async rebaseSession(request: RebasePreviewRuntimeRequest): Promise<void> {
    const session = this.sessions.get(request.previewSessionId)
    if (!session || session.released) return
    this.cancelExchanges(session)
    session.contentBasis = request.contentBasis
    session.runtimeGeneration = request.runtimeGeneration
    session.sequence = 0
    session.scene = request.scene
    session.entryName = sceneLabel(request.scene)
    this.notifyReadyWaiters()
  }

  async setSceneTextOverlay(request: SceneTextOverlayRequest): Promise<void> {
    const session = this.sessions.get(request.previewSessionId)
    if (!session) throw new SceneOverlayRejected('sessionNotFound')
    if (session.released) throw new SceneOverlayRejected('sessionClosed')
    if (request.runtimeGeneration !== session.runtimeGeneration) {
      throw new SceneOverlayRejected('staleRuntimeGeneration')
    }
    if (
      this.sceneOverlay &&
      this.sceneOverlay.previewSessionId === request.previewSessionId &&
      request.editRevision < this.sceneOverlay.editRevision
    ) {
      throw new SceneOverlayRejected('staleRuntimeGeneration')
    }
    try {
      await this.options.host.setSceneTextOverlay(request)
    } catch (error) {
      if (error instanceof SceneOverlayUnavailable) throw overlayRejection(error.reason)
      throw error
    }
    this.sceneOverlay = request
  }

  async currentSceneTextOverlayRevision(scope: SceneTextOverlayScope): Promise<number> {
    return this.options.host.currentSceneTextOverlayRevision(scope)
  }

  async clearSceneTextOverlay(scope: SceneTextOverlayScope): Promise<void> {
    await this.options.host.clearSceneTextOverlay(scope)
    if (
      this.sceneOverlay?.previewSessionId === scope.previewSessionId &&
      (scope.runtimeGeneration === undefined ||
        this.sceneOverlay.runtimeGeneration === scope.runtimeGeneration)
    ) {
      this.sceneOverlay = undefined
    }
  }

  async playDialogue(request: PlayPreviewDialogueRequest): Promise<PreviewCommandResultVO> {
    const session = this.requireSession(request)
    if (!session) return { status: 'failed', failure: runtimeFailure('runtimeNotPrepared') }
    if ('failure' in session) return { status: 'failed', failure: session.failure }
    const sentence = dialogueSentence(request.scene, request.dialogueId)
    if (!sentence) return { status: 'failed', failure: runtimeFailure('dialogueObjectInvalid') }
    const connection = this.readyConnection() ?? (await this.waitForReady(session))
    if (!connection || session.released) {
      return { status: 'failed', failure: runtimeFailure('runtimeNotReady') }
    }
    if (request.expectedRuntimeGeneration !== session.runtimeGeneration) {
      return { status: 'failed', failure: runtimeFailure('staleRuntimeGeneration') }
    }
    this.activeSessionId = session.previewSessionId
    session.scene = request.scene
    session.entryName = sceneLabel(request.scene)
    const startupFailure =
      session.trustedInput === undefined ? null : await this.ensureStarted(session, connection)
    if (startupFailure !== null) {
      return { status: 'failed', failure: startupFailure }
    }
    if (session.released) {
      return { status: 'failed', failure: runtimeFailure('runtimeNotReady') }
    }
    if (request.expectedRuntimeGeneration !== session.runtimeGeneration) {
      return { status: 'failed', failure: runtimeFailure('staleRuntimeGeneration') }
    }
    const stopSentenceId = sentence.engineSentenceIndex + 1
    const result = await this.exchange(
      connection,
      session,
      sceneLabel(request.scene),
      stopSentenceId,
      'preview.command.sync-scene',
      {
        sceneName: sceneLabel(request.scene),
        sentenceId: stopSentenceId,
        debugVariables: [],
        settleMode: 'normal'
      }
    )
    if (result.status === 'rejected') {
      return {
        status: 'failed',
        failure: runtimeFailure(
          session.runtimeGeneration !== request.expectedRuntimeGeneration
            ? 'staleRuntimeGeneration'
            : 'runtimeNotReady'
        )
      }
    }
    if (result.status === 'timeout') {
      return {
        status: 'failed',
        failure: runtimeFailure(
          result.timedOut
            ? 'commandTimeout'
            : branchChoiceRequired(result.snapshot)
              ? 'branchChoiceRequired'
              : 'locateNotReached'
        )
      }
    }
    if (session.released) {
      return { status: 'failed', failure: runtimeFailure('runtimeNotReady') }
    }
    if (session.runtimeGeneration !== request.expectedRuntimeGeneration) {
      return { status: 'failed', failure: runtimeFailure('staleRuntimeGeneration') }
    }
    const stage = this.nextStage(session, {
      kind: 'dialogue',
      dialogueId: request.dialogueId
    })
    this.emitStage(session, stage)
    return { status: 'confirmed', stage }
  }

  subscribe(scope: PreviewSessionRef, listener: PreviewRuntimeListener): () => void {
    const session = this.sessions.get(scope.previewSessionId)
    if (!session || session.released) return () => undefined
    session.listeners.add(listener)
    return () => session.listeners.delete(listener)
  }

  async release(scope: PreviewSessionRef): Promise<void> {
    const session = this.sessions.get(scope.previewSessionId)
    if (!session || session.released) return
    session.released = true
    session.startupAttemptAbort?.abort(new Error('预览会话已关闭'))
    session.trustedInputAbort?.abort(new Error('预览会话已关闭'))
    session.startFeed = undefined
    this.cancelExchanges(session)
    session.listeners.clear()
    this.sessions.delete(scope.previewSessionId)
    if (this.activeSessionId === scope.previewSessionId) this.activeSessionId = undefined
    if (this.sceneOverlay?.previewSessionId === scope.previewSessionId) {
      this.sceneOverlay = undefined
      await this.options.host.clearSceneTextOverlay(scope)
    }
    this.notifyReadyWaiters()
  }

  /** 释放监听并关闭宿主；生产进程结束时调用。 */
  async dispose(): Promise<void> {
    this.removeHostConnection()
    for (const session of this.sessions.values()) {
      session.released = true
      session.startupAttemptAbort?.abort(new Error('预览会话已关闭'))
      session.trustedInputAbort?.abort(new Error('预览会话已关闭'))
      session.startFeed = undefined
      this.cancelExchanges(session)
      session.listeners.clear()
    }
    this.sessions.clear()
    this.candidateSessions.clear()
    for (const state of this.connections.values()) {
      state.removeMessage()
      state.removeClose()
    }
    this.connections.clear()
    for (const waiter of [...this.readyWaiters]) waiter.resolve(undefined)
    this.readyWaiters.clear()
  }

  async prepareCandidate(request: CandidateRuntimeRequest): Promise<PreviewStageResultVO> {
    this.candidateSessions.set(request.candidateSessionId, {
      candidateSnapshotId: request.candidateSnapshotId
    })
    if (this.options.bridge.controlCapability().status === 'unavailable') {
      this.candidateSessions.delete(request.candidateSessionId)
      return { status: 'failed', failure: runtimeFailure('engineCapabilityUnavailable') }
    }
    return { status: 'failed', failure: runtimeFailure('prepareFailed') }
  }

  async invalidateCandidate(scope: { readonly candidateSessionId: string }): Promise<void> {
    this.candidateSessions.delete(scope.candidateSessionId)
    this.notifyReadyWaiters()
  }

  /** 每次准备都换一份可信输入和运行代次，旧页面或旧等待不能进入新舞台。 */
  private resetStartup(session: RuntimeSession, handle: WebgalRuntimeHandle): void {
    session.startupAttemptAbort?.abort(new Error('预览会话已关闭'))
    session.startupAttemptAbort = undefined
    session.startup = undefined
    session.startupConnection = undefined
    session.startFeed = undefined
    session.startedConnection = undefined
    session.lastSnapshot = undefined
    session.trustedInputAbort?.abort(new Error('预览会话已关闭'))
    session.trustedInputAbort = undefined
    session.trustedInput = undefined
    session.stagePageUrl = undefined
    session.packageVersion = handle.build.packageVersion
    if (!this.options.trustedInput) return
    const abort = new AbortController()
    session.trustedInputAbort = abort
    const input = this.options.trustedInput({
      stageUrl: `${handle.baseUrl}/`,
      signal: abort.signal
    })
    if (!input) return
    session.trustedInput = input
    session.stagePageUrl = input.stagePageUrl
  }

  /**
   * 舞台注册就绪不等于离开语言和标题层。提供可信输入时，先用真实画面确认进入游戏，
   * 失败或超时明确返回，不把标题画面上的 sync-scene 当成定位成功。
   */
  private ensureStarted(
    session: RuntimeSession,
    connection: WebgalPreviewConnection
  ): Promise<PreviewErrorVO | null> {
    if (session.trustedInput === undefined) return Promise.resolve(null)
    if (session.startedConnection === connection) return Promise.resolve(null)
    if (session.startupConnection === connection && session.startup) return session.startup
    session.startupAttemptAbort?.abort(new Error('预览页面已更换'))
    const support = selectCandidateStartSupport({
      packageVersion: session.packageVersion ?? '',
      commands: WEBGAL_COMPATIBILITY_PROFILE.previewCommands
    })
    if (support !== 'trusted-input') {
      return Promise.resolve(runtimeFailure('engineCapabilityUnavailable'))
    }
    const feed = new CandidateStageFeed()
    const last = session.lastSnapshot
    if (last && last.connection === connection) {
      feed.push({
        sceneName: last.snapshot.sceneName,
        sentenceId: last.snapshot.sentenceId,
        stageState: last.snapshot.stageState
      })
    }
    session.startFeed = feed
    session.startupConnection = connection
    const attempt = new AbortController()
    session.startupAttemptAbort = attempt
    const timer = setTimeout(
      () => attempt.abort(new Error('等待 WebGAL 开始游戏超时')),
      this.startupTimeoutMs
    )
    const record: { promise?: Promise<PreviewErrorVO | null> } = {}
    const startup = (async (): Promise<PreviewErrorVO | null> => {
      try {
        await confirmCandidateGame({
          sceneName: sceneIdentity(session.entryName),
          signal: attempt.signal,
          feed,
          support,
          input: session.trustedInput ?? null
        })
        session.startedConnection = connection
        return null
      } catch (error) {
        return this.startupFailureOf(error)
      } finally {
        clearTimeout(timer)
        if (session.startFeed === feed) session.startFeed = undefined
        if (session.startupAttemptAbort === attempt) session.startupAttemptAbort = undefined
        if (session.startup === record.promise) {
          session.startup = undefined
          session.startupConnection = undefined
        }
      }
    })()
    record.promise = startup
    session.startup = startup
    return startup
  }

  private startupFailureOf(error: unknown): PreviewErrorVO {
    if (error instanceof CandidateStartError) {
      return runtimeFailure(
        error.message === '当前引擎不支持开始游戏' ? 'engineCapabilityUnavailable' : 'prepareFailed'
      )
    }
    const message = error instanceof Error ? error.message : ''
    if (message.includes('超时')) return runtimeFailure('commandTimeout')
    if (message.includes('关闭')) return runtimeFailure('sessionClosed')
    return runtimeFailure('prepareFailed')
  }

  private async bindProject(
    request: PreparePreviewRuntimeRequest
  ): Promise<{ entryName: string } | undefined> {
    const entryName = basename(request.entryFile.replaceAll('\\', '/'))
    if (entryName === '' || entryName === '.' || entryName === '..' || entryName.includes('/')) {
      return undefined
    }
    try {
      await this.options.host.useProjectRoot(request.projectRoot)
      return { entryName }
    } catch {
      return undefined
    }
  }

  private openSession(request: PreparePreviewRuntimeRequest, entryName: string): RuntimeSession {
    const existing = this.sessions.get(request.previewSessionId)
    if (existing && !existing.released) {
      this.cancelExchanges(existing)
      existing.contentBasis = request.contentBasis
      existing.runtimeGeneration = request.runtimeGeneration
      existing.sequence = 0
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

  private requireSession(
    request: PlayPreviewDialogueRequest
  ): RuntimeSession | SessionRejection | undefined {
    const session = this.sessions.get(request.previewSessionId)
    if (!session || session.released) return undefined
    if (request.expectedRuntimeGeneration !== session.runtimeGeneration) {
      return { failure: runtimeFailure('staleRuntimeGeneration') }
    }
    return session
  }

  private attachConnection(connection: WebgalPreviewConnection): void {
    if (this.connections.has(connection)) return
    let state!: ConnectionState
    const removeMessage = connection.onMessage((message) => this.receive(state, message))
    const removeClose = connection.onClose(() => this.detachConnection(connection))
    state = {
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
    const session = this.activeSessionId ? this.sessions.get(this.activeSessionId) : undefined
    if (!session || session.released) return
    if (!sameScene(snapshot.sceneName, session.entryName)) return
    session.lastSnapshot = { connection, snapshot }
    if (session.startupConnection === connection) {
      session.startFeed?.push({
        sceneName: snapshot.sceneName,
        sentenceId: snapshot.sentenceId,
        stageState: snapshot.stageState
      })
    }
    if (session.pendingExchanges.size > 0) return
    const stage = this.nextStage(session, snapshotPosition(session, snapshot))
    this.emitStage(session, stage)
  }

  private readyConnection(): WebgalPreviewConnection | undefined {
    for (const state of this.connections.values()) {
      if (state.ready) return state.connection
    }
    return undefined
  }

  private waitForReady(session: RuntimeSession): Promise<WebgalPreviewConnection | undefined> {
    const ready = this.readyConnection()
    if (ready) return Promise.resolve(ready)
    if (session.released) return Promise.resolve(undefined)
    const { promise, resolve } = Promise.withResolvers<WebgalPreviewConnection | undefined>()
    let waiter!: ReadyWaiter
    const timer = setTimeout(() => {
      this.readyWaiters.delete(waiter)
      resolve(undefined)
    }, this.timeoutMs)
    waiter = {
      session,
      resolve: (connection) => {
        clearTimeout(timer)
        this.readyWaiters.delete(waiter)
        resolve(connection)
      }
    }
    this.readyWaiters.add(waiter)
    return promise
  }

  private notifyReadyWaiters(): void {
    const ready = this.readyConnection()
    for (const waiter of [...this.readyWaiters]) {
      if (waiter.session.released) {
        waiter.resolve(undefined)
        continue
      }
      if (ready) waiter.resolve(ready)
    }
  }

  private nextStage(
    session: RuntimeSession,
    position: PreviewPositionVO,
    phase: PreviewPhase = 'unknown'
  ): PreviewStageVO {
    session.sequence += 1
    const stage: PreviewStageVO = {
      previewSessionId: session.previewSessionId,
      contentBasis: session.contentBasis,
      runtimeGeneration: session.runtimeGeneration,
      sequence: session.sequence,
      phase,
      position
    }
    return stage
  }

  private emitStage(session: RuntimeSession, stage: PreviewStageVO): void {
    for (const listener of session.listeners) {
      try {
        listener({ type: 'stage', ...stage })
      } catch {
        // 单个监听器失败不影响其他监听器。
      }
    }
  }

  private cancelExchanges(session: RuntimeSession): void {
    for (const cancel of [...session.pendingExchanges]) cancel()
  }

  private exchange(
    connection: WebgalPreviewConnection,
    session: RuntimeSession,
    sceneName: string,
    sentenceId: number,
    type: string,
    payload: Record<string, unknown>
  ): Promise<ExchangeResult> {
    const requestId = `preview-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const generation = session.runtimeGeneration
    const { promise, resolve } = Promise.withResolvers<ExchangeResult>()
    let commandAccepted = false
    let fastPreviewTimedOut = false
    let latest: StageSnapshot | undefined
    let settled = false
    let stop = (): void => undefined
    let cancel = (): void => undefined
    const finish = (result: ExchangeResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stop()
      session.pendingExchanges.delete(cancel)
      resolve(result)
    }
    cancel = () => finish({ status: 'rejected' })
    session.pendingExchanges.add(cancel)
    const timer = setTimeout(
      () => finish({ status: 'timeout', timedOut: fastPreviewTimedOut, snapshot: latest }),
      this.timeoutMs
    )
    stop = connection.onMessage((message) => {
      if (session.released || session.runtimeGeneration !== generation) return
      if (message && typeof message === 'object' && 'kind' in message) {
        const kind = message.kind
        if (
          kind === 'event' &&
          'type' in message &&
          message.type === 'preview.event.fast-preview-timeout'
        ) {
          fastPreviewTimedOut = true
          finish({ status: 'timeout', timedOut: true })
          return
        }
        if (
          'requestId' in message &&
          message.requestId === requestId &&
          'type' in message &&
          message.type === type
        ) {
          if (kind === 'error') finish({ status: 'rejected' })
          else if (kind === 'response') commandAccepted = true
        }
      }
      const snapshot = readSnapshot(message)
      if (!snapshot || !commandAccepted || fastPreviewTimedOut) return
      latest = snapshot
      if (!sameScene(snapshot.sceneName, sceneName)) return
      if (snapshot.sentenceId < sentenceId) return
      finish({ status: 'snapshot', snapshot })
    })
    try {
      connection.send({ kind: 'request', type, requestId, payload })
    } catch {
      finish({ status: 'rejected' })
    }
    return promise
  }
}

function dialogueSentence(scene: ParsedScene, dialogueId: string): ParsedSceneSentence | undefined {
  return scene.sentences.find(
    (sentence) =>
      sentence.command === 'say' &&
      !sentence.isLineBreakHolder &&
      String(sentence.sequence) === dialogueId
  )
}

function sceneLabel(scene: ParsedScene): string {
  return basename(scene.sourceFile.relativePath.replaceAll('\\', '/'))
}

/**
 * 把舞台快照的句号映射回源台词。
 * 快照句号是停止指针语义，目标语句下标为句号减一；无法精确映射时保持 unknown。
 */
function snapshotPosition(session: RuntimeSession, snapshot: StageSnapshot): PreviewPositionVO {
  if (snapshot.sentenceId <= 0) return { kind: 'unknown' }
  const sentence = session.scene.sentences.find(
    (item) => item.engineSentenceIndex === snapshot.sentenceId - 1
  )
  if (!sentence) return { kind: 'unknown' }
  if (sentence.command !== 'say' || sentence.isLineBreakHolder) return { kind: 'nonDialogue' }
  return { kind: 'dialogue', dialogueId: String(sentence.sequence) }
}

function sceneIdentity(name: string): string {
  const normalized = name.replaceAll('\\', '/')
  const fileName = normalized.slice(normalized.lastIndexOf('/') + 1)
  return fileName.replace(/\.txt$/u, '')
}

function sameScene(left: string, right: string): boolean {
  return sceneIdentity(left) === sceneIdentity(right)
}

function sameBasis(left: SceneContentBasisVO, right: SceneContentBasisVO): boolean {
  return (
    left.digest === right.digest &&
    left.parserVersion === right.parserVersion &&
    left.engineVersion === right.engineVersion
  )
}

function readSnapshot(message: unknown): StageSnapshot | undefined {
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

function branchChoiceRequired(snapshot: StageSnapshot | undefined): boolean {
  const state = snapshot?.stageState
  if (!state || typeof state !== 'object') return false
  if (!('choose' in state)) return false
  return Array.isArray(state.choose) && state.choose.length > 0
}

function overlayRejection(reason: SceneOverlayUnavailableReason): SceneOverlayRejected {
  switch (reason) {
    case 'stale-generation':
      return new SceneOverlayRejected('staleRuntimeGeneration')
    case 'foreign-session':
      return new SceneOverlayRejected('sessionNotFound')
    case 'stale-revision':
    case 'digest-mismatch':
    case 'invalid-overlay':
      return new SceneOverlayRejected('invalidRequest')
  }
}
