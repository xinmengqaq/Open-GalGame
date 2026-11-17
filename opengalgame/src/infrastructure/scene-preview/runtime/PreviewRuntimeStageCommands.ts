import {
  SceneOverlayRejected,
  type SceneTextOverlayRequest,
  type SceneTextOverlayScope
} from '@application/scene-preview/ports/PreviewRuntimeGateway'
import type {
  PreviewPhase,
  PreviewPositionVO,
  PreviewRuntimeListener,
  PreviewStageVO
} from '@application/scene-preview/vo/PreviewRuntimeVO'
import {
  SceneOverlayUnavailable,
  type SceneOverlayUnavailableReason,
  type WebgalPreviewConnection,
  type WebgalRuntimeHost
} from '@infrastructure/webgal/runtime/WebgalRuntimeHostImpl'

import {
  readSnapshot,
  sameScene,
  type RuntimeSession,
  type StageSnapshot
} from './PreviewRuntimeSessionRegistry'

export type ExchangeResult =
  | { readonly status: 'snapshot'; readonly snapshot: StageSnapshot }
  | { readonly status: 'timeout'; readonly timedOut: boolean; readonly snapshot?: StageSnapshot }
  | { readonly status: 'rejected' }

/**
 * 舞台序号、监听器、在途命令和覆盖层槽的唯一所有者。
 * 命令确认必须等匹配响应后的同场景停止指针快照；事件按会话代次过滤。
 */
export class PreviewRuntimeStageCommands {
  private readonly timeoutMs: number
  private sceneOverlay: SceneTextOverlayRequest | undefined

  constructor(
    private readonly host: WebgalRuntimeHost,
    timeoutMs: number
  ) {
    this.timeoutMs = timeoutMs
  }

  /** 准备返回的舞台固定从序号 1 开始，不代表已经定位。 */
  prepareStage(session: RuntimeSession): PreviewStageVO {
    session.sequence = 1
    return {
      previewSessionId: session.previewSessionId,
      contentBasis: session.contentBasis,
      runtimeGeneration: session.runtimeGeneration,
      sequence: session.sequence,
      phase: 'unknown',
      position: { kind: 'unknown' }
    }
  }

  resetSequence(session: RuntimeSession): void {
    session.sequence = 0
  }

  advanceStage(
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
    this.emitStage(session, stage)
    return stage
  }

  subscribe(session: RuntimeSession, listener: PreviewRuntimeListener): () => void {
    session.listeners.add(listener)
    return () => session.listeners.delete(listener)
  }

  /** 释放会话时中止在途命令并清空监听，单个监听器失败不影响其他监听器。 */
  detach(session: RuntimeSession): void {
    this.cancelExchanges(session)
    session.listeners.clear()
  }

  cancelExchanges(session: RuntimeSession): void {
    for (const cancel of [...session.pendingExchanges]) cancel()
  }

  forwardSnapshot(session: RuntimeSession, snapshot: StageSnapshot): void {
    if (session.pendingExchanges.size > 0) return
    this.advanceStage(session, snapshotPosition(session, snapshot))
  }

  exchange(
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

  async setOverlay(request: SceneTextOverlayRequest): Promise<void> {
    if (
      this.sceneOverlay &&
      this.sceneOverlay.previewSessionId === request.previewSessionId &&
      request.editRevision < this.sceneOverlay.editRevision
    ) {
      throw new SceneOverlayRejected('staleRuntimeGeneration')
    }
    try {
      await this.host.setSceneTextOverlay(request)
    } catch (error) {
      if (error instanceof SceneOverlayUnavailable) throw overlayRejection(error.reason)
      throw error
    }
    this.sceneOverlay = request
  }

  currentOverlayRevision(scope: SceneTextOverlayScope): Promise<number> {
    return this.host.currentSceneTextOverlayRevision(scope)
  }

  async clearOverlay(scope: SceneTextOverlayScope): Promise<void> {
    await this.host.clearSceneTextOverlay(scope)
    if (
      this.sceneOverlay?.previewSessionId === scope.previewSessionId &&
      (scope.runtimeGeneration === undefined ||
        this.sceneOverlay.runtimeGeneration === scope.runtimeGeneration)
    ) {
      this.sceneOverlay = undefined
    }
  }

  /** 准备换代时丢弃旧覆盖层，再让宿主清除同一会话的画面文本。 */
  async discardOverlay(previewSessionId: string): Promise<void> {
    this.sceneOverlay = undefined
    await this.host.clearSceneTextOverlay({ previewSessionId })
  }

  /** 只清理属于该会话的全局覆盖槽，不影响其他会话。 */
  async releaseOverlay(scope: SceneTextOverlayScope): Promise<void> {
    if (this.sceneOverlay?.previewSessionId === scope.previewSessionId) {
      this.sceneOverlay = undefined
      await this.host.clearSceneTextOverlay(scope)
    }
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
