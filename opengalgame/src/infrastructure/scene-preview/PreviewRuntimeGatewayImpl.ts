import { basename } from 'node:path'
import type { ParsedScene, ParsedSceneSentence } from '@application/scenes/models/ParsedScene'
import {
  SceneOverlayRejected,
  type PlayPreviewDialogueRequest,
  type PreparePreviewRuntimeRequest,
  type PreviewRuntimeGateway,
  type RebasePreviewRuntimeRequest,
  type SceneTextOverlayRequest,
  type SceneTextOverlayScope
} from '@application/scene-preview/ports/PreviewRuntimeGateway'
import type { PreviewSessionRef } from '@application/scene-preview/dto/PreviewPlaybackDTO'
import type { SceneContentBasisVO } from '@application/scene-preview/vo/ScenePreviewSessionVO'
import type {
  PreviewCommandResultVO,
  PreviewRuntimeListener,
  PreviewStageResultVO
} from '@application/scene-preview/vo/PreviewRuntimeVO'
import type { WebgalRuntimeHost } from '@infrastructure/webgal/runtime/WebgalRuntimeHostImpl'
import type { CandidateTrustedInputSource } from '@infrastructure/webgal/compatibility/candidateGameStart'
import type { WebgalPreviewControlBridge } from '@infrastructure/webgal/preview/WebgalPreviewControlBridge'

import { runtimeFailure } from './previewRuntimeErrors'
import {
  PreviewRuntimeSessionRegistry,
  sameScene,
  type StageSnapshot
} from './runtime/PreviewRuntimeSessionRegistry'
import { PreviewRuntimeStartup } from './runtime/PreviewRuntimeStartup'
import { PreviewRuntimeStageCommands } from './runtime/PreviewRuntimeStageCommands'

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

/**
 * 当前场景预览运行时。
 * 准备只返回宿主给出的可嵌入地址；真实注册、就绪和舞台快照由引擎消息确认。
 * sync-scene 只证明台词已定位，舞台快照没有播放阶段，不能报暂停或播放。
 */
export class PreviewRuntimeGatewayImpl implements PreviewRuntimeGateway {
  private readonly registry: PreviewRuntimeSessionRegistry
  private readonly startup: PreviewRuntimeStartup
  private readonly stage: PreviewRuntimeStageCommands

  constructor(private readonly options: PreviewRuntimeGatewayOptions) {
    const timeoutMs = options.timeoutMs ?? 5_000
    const startupTimeoutMs = options.startupTimeoutMs ?? 20_000
    const stage = new PreviewRuntimeStageCommands(options.host, timeoutMs)
    const startup = new PreviewRuntimeStartup({
      trustedInput: options.trustedInput,
      timeoutMs,
      startupTimeoutMs
    })
    this.stage = stage
    this.startup = startup
    this.registry = new PreviewRuntimeSessionRegistry(options.host, {
      onSnapshot: (session, snapshot, connection) => {
        startup.recordSnapshot(session, snapshot, connection)
        stage.forwardSnapshot(session, snapshot)
      }
    })
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
    const previous = this.registry.session(request.previewSessionId)
    if (
      previous &&
      !previous.released &&
      (previous.runtimeGeneration !== request.runtimeGeneration ||
        !sameBasis(previous.contentBasis, request.contentBasis) ||
        !sameScene(previous.entryName, root.entryName))
    ) {
      this.stage.cancelExchanges(previous)
      await this.stage.discardOverlay(request.previewSessionId)
    }
    const reuse = this.registry.session(request.previewSessionId)
    if (reuse && !reuse.released) this.stage.cancelExchanges(reuse)
    const session = this.registry.openSession(request, root.entryName)
    if (session.released) return { status: 'failed', failure: runtimeFailure('prepareFailed') }
    this.registry.activate(session.previewSessionId)
    const stage = this.stage.prepareStage(session)
    this.startup.reset(session, handle)
    return {
      status: 'ready',
      stageUrl: session.stagePageUrl ?? `${handle.baseUrl}/index.html`,
      stage
    }
  }

  async rebaseSession(request: RebasePreviewRuntimeRequest): Promise<void> {
    const session = this.registry.session(request.previewSessionId)
    if (!session || session.released) return
    this.stage.cancelExchanges(session)
    this.registry.rebaseSession(
      session,
      request.contentBasis,
      request.runtimeGeneration,
      request.scene,
      sceneLabel(request.scene)
    )
    this.stage.resetSequence(session)
    this.registry.notifyReadyWaiters()
  }

  async setSceneTextOverlay(request: SceneTextOverlayRequest): Promise<void> {
    const session = this.registry.session(request.previewSessionId)
    if (!session) throw new SceneOverlayRejected('sessionNotFound')
    if (session.released) throw new SceneOverlayRejected('sessionClosed')
    if (request.runtimeGeneration !== session.runtimeGeneration) {
      throw new SceneOverlayRejected('staleRuntimeGeneration')
    }
    await this.stage.setOverlay(request)
  }

  async currentSceneTextOverlayRevision(scope: SceneTextOverlayScope): Promise<number> {
    return this.stage.currentOverlayRevision(scope)
  }

  async clearSceneTextOverlay(scope: SceneTextOverlayScope): Promise<void> {
    await this.stage.clearOverlay(scope)
  }

  async playDialogue(request: PlayPreviewDialogueRequest): Promise<PreviewCommandResultVO> {
    const session = this.registry.requireSession(
      request.previewSessionId,
      request.expectedRuntimeGeneration
    )
    if (!session) return { status: 'failed', failure: runtimeFailure('runtimeNotPrepared') }
    if ('failure' in session) return { status: 'failed', failure: session.failure }
    const sentence = dialogueSentence(request.scene, request.dialogueId)
    if (!sentence) return { status: 'failed', failure: runtimeFailure('dialogueObjectInvalid') }
    const connection =
      this.registry.readyConnection() ?? (await this.startup.waitForReady(session, this.registry))
    if (!connection || session.released) {
      return { status: 'failed', failure: runtimeFailure('runtimeNotReady') }
    }
    if (request.expectedRuntimeGeneration !== session.runtimeGeneration) {
      return { status: 'failed', failure: runtimeFailure('staleRuntimeGeneration') }
    }
    this.registry.activate(session.previewSessionId)
    this.registry.updateScene(session, request.scene, sceneLabel(request.scene))
    const startupFailure =
      session.trustedInput === undefined
        ? null
        : await this.startup.ensureStarted(session, connection)
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
    const result = await this.stage.exchange(
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
    const stage = this.stage.advanceStage(session, {
      kind: 'dialogue',
      dialogueId: request.dialogueId
    })
    return { status: 'confirmed', stage }
  }

  subscribe(scope: PreviewSessionRef, listener: PreviewRuntimeListener): () => void {
    const session = this.registry.session(scope.previewSessionId)
    if (!session || session.released) return () => undefined
    return this.stage.subscribe(session, listener)
  }

  async release(scope: PreviewSessionRef): Promise<void> {
    const session = this.registry.session(scope.previewSessionId)
    if (!session || session.released) return
    this.registry.markReleased(session)
    this.startup.abort(session)
    this.stage.detach(session)
    this.registry.forget(session)
    await this.stage.releaseOverlay(scope)
    this.registry.notifyReadyWaiters()
  }

  /** 释放监听并关闭宿主；生产进程结束时调用。 */
  async dispose(): Promise<void> {
    this.registry.detachHost()
    for (const session of this.registry.allSessions()) {
      this.registry.markReleased(session)
      this.startup.abort(session)
      this.stage.detach(session)
    }
    this.registry.clearSessions()
    this.registry.clearCandidates()
    this.registry.detachAllConnections()
    this.registry.resolveAllReadyWaiters()
  }

  async prepareCandidate(request: CandidateRuntimeRequest): Promise<PreviewStageResultVO> {
    this.registry.rememberCandidate(request.candidateSessionId, request.candidateSnapshotId)
    if (this.options.bridge.controlCapability().status === 'unavailable') {
      this.registry.forgetCandidate(request.candidateSessionId)
      return { status: 'failed', failure: runtimeFailure('engineCapabilityUnavailable') }
    }
    return { status: 'failed', failure: runtimeFailure('prepareFailed') }
  }

  async invalidateCandidate(scope: { readonly candidateSessionId: string }): Promise<void> {
    this.registry.forgetCandidate(scope.candidateSessionId)
    this.registry.notifyReadyWaiters()
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

function sameBasis(left: SceneContentBasisVO, right: SceneContentBasisVO): boolean {
  return (
    left.digest === right.digest &&
    left.parserVersion === right.parserVersion &&
    left.engineVersion === right.engineVersion
  )
}

function branchChoiceRequired(snapshot: StageSnapshot | undefined): boolean {
  const state = snapshot?.stageState
  if (!state || typeof state !== 'object') return false
  if (!('choose' in state)) return false
  return Array.isArray(state.choose) && state.choose.length > 0
}
