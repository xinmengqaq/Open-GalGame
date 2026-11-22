import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'

import type { SceneGenerationCandidatePreviewEventVO } from '@application/scene-generation/vo/SceneGenerationRenderVO'
import type { PreviewRuntimeEventVO } from '@application/scene-preview/vo/PreviewRuntimeVO'
import { createIpcRequestAccess, isTrustedIpcSender } from '../../ipc/createIpcRequestAccess'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { parseRequest } from '../../ipc/RequestSchema'
import { subscribePreviewRuntimeSchema } from './ScenePreviewRequestSchema'
import type { ScenePreviewController } from './ScenePreviewController'

interface ScenePreviewIpcBinding {
  scenePreview: ScenePreviewController
  getWindow: () => BrowserWindow | null
  rendererUrl: string
}

interface ScenePreviewSubscription {
  senderId: number
  previewSessionId: string
  lastGeneration: number
  lastSequence: number
  unsubscribe: () => void
}

interface ScenePreviewIpcScope {
  readonly subscriptions: Map<number, ScenePreviewSubscription>
  readonly seenGenerations: Map<string, number>
  stopCandidateEvents: (() => void) | undefined
}

export function registerScenePreviewIpc(options: ScenePreviewIpcBinding): () => void {
  const access = createIpcRequestAccess(options)
  const scope: ScenePreviewIpcScope = {
    subscriptions: new Map(),
    seenGenerations: new Map(),
    stopCandidateEvents: undefined
  }
  const handlers: Record<string, (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>> =
    {
      'scene-preview:availability': (event, input) =>
        options.scenePreview.readAvailability(input, access(event)),
      'scene-preview:open': (event, input) => options.scenePreview.open(input, access(event)),
      'scene-preview:prepare': (event, input) => options.scenePreview.prepare(input, access(event)),
      'scene-preview:draft': (event, input) =>
        options.scenePreview.previewDraft(input, access(event)),
      'scene-preview:save': (event, input) => options.scenePreview.save(input, access(event)),
      'scene-preview:settlement': (event, input) =>
        options.scenePreview.readSettlement(input, access(event)),
      'scene-preview:select-dialogue': (event, input) =>
        options.scenePreview.selectDialogue(input, access(event)),
      'scene-preview:previous-dialogue': (event, input) =>
        options.scenePreview.previousDialogue(input, access(event)),
      'scene-preview:next-dialogue': (event, input) =>
        options.scenePreview.nextDialogue(input, access(event)),
      'scene-preview:close': (event, input) => closeScenePreview(options, event, input, scope),
      'scene-preview:subscribe': (event, input) =>
        subscribeScenePreviewRuntime(options, event, input, scope),
      'scene-preview:read-candidate': (event, input) =>
        options.scenePreview.readCandidate(input, access(event)),
      'scene-preview:candidate-event': (event, input) =>
        options.scenePreview.readCandidateEvent(input, access(event))
    }
  for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, handler)
  scope.stopCandidateEvents = bindCandidatePreviewEvents(
    options.scenePreview,
    options.getWindow
  )
  return () => {
    for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel)
    releaseScenePreviewSubscriptions(scope)
  }
}

function releaseScenePreviewSubscriptions(scope: ScenePreviewIpcScope): void {
  for (const subscription of scope.subscriptions.values()) subscription.unsubscribe()
  scope.subscriptions.clear()
  scope.seenGenerations.clear()
  scope.stopCandidateEvents?.()
  scope.stopCandidateEvents = undefined
}

async function closeScenePreview(
  options: ScenePreviewIpcBinding,
  event: IpcMainInvokeEvent,
  input: unknown,
  scope: ScenePreviewIpcScope
): Promise<unknown> {
  const requestAccess = createIpcRequestAccess(options)(event)
  const closed = await options.scenePreview.close(input, requestAccess)
  if (closed.code === 2000) releaseSenderSubscription(scope, event.sender?.id)
  return closed
}

async function subscribeScenePreviewRuntime(
  options: ScenePreviewIpcBinding,
  event: IpcMainInvokeEvent,
  input: unknown,
  scope: ScenePreviewIpcScope
): Promise<unknown> {
  const requestAccess = createIpcRequestAccess(options)(event)
  const sender = event.sender
  const queued: PreviewRuntimeEventVO[] = []
  const subscription: { current: ScenePreviewSubscription | undefined } = { current: undefined }
  const publish = (runtimeEvent: PreviewRuntimeEventVO): void => {
    const active = subscription.current
    if (!active) {
      queued.push(runtimeEvent)
      return
    }
    deliverRuntimeEvent(options, event, sender, active, runtimeEvent, scope)
  }
  const subscribed = await options.scenePreview.subscribe(input, requestAccess, publish)
  if (
    subscribed.accepted.code !== ErrorCodes.success ||
    !sender ||
    sender.isDestroyed() ||
    !subscribed.unsubscribe
  ) {
    subscribed.unsubscribe?.()
    return subscribed.accepted
  }
  const request = parseRequest(subscribePreviewRuntimeSchema, input, requestAccess)
  releaseSenderSubscription(scope, sender.id)
  const current: ScenePreviewSubscription = {
    senderId: sender.id,
    previewSessionId: request.previewSessionId,
    lastGeneration: 0,
    lastSequence: 0,
    unsubscribe: subscribed.unsubscribe
  }
  subscription.current = current
  scope.subscriptions.set(sender.id, current)
  for (const runtimeEvent of queued) {
    deliverRuntimeEvent(options, event, sender, current, runtimeEvent, scope)
  }
  sender.once('destroyed', () => {
    releaseSenderSubscription(scope, sender.id)
  })
  return subscribed.accepted
}

function deliverRuntimeEvent(
  options: ScenePreviewIpcBinding,
  event: IpcMainInvokeEvent,
  sender: IpcMainInvokeEvent['sender'] | undefined,
  current: ScenePreviewSubscription,
  runtimeEvent: PreviewRuntimeEventVO,
  scope: ScenePreviewIpcScope
): void {
  if (
    !sender ||
    sender.isDestroyed() ||
    !isTrustedIpcSender(event, options) ||
    !isCurrentRuntimeEvent(scope, current, runtimeEvent)
  ) {
    return
  }
  const seenGeneration = scope.seenGenerations.get(current.previewSessionId) ?? 0
  current.lastGeneration = Math.max(seenGeneration, runtimeEvent.runtimeGeneration)
  current.lastSequence = runtimeEvent.sequence
  scope.seenGenerations.set(current.previewSessionId, current.lastGeneration)
  sender.send('scene-preview:runtime', runtimeEvent)
}

function releaseSenderSubscription(
  scope: ScenePreviewIpcScope,
  senderId: number | undefined
): void {
  if (senderId === undefined) return
  scope.subscriptions.get(senderId)?.unsubscribe()
  scope.subscriptions.delete(senderId)
}

function isCurrentRuntimeEvent(
  scope: ScenePreviewIpcScope,
  subscription: ScenePreviewSubscription,
  runtimeEvent: PreviewRuntimeEventVO
): boolean {
  if (runtimeEvent.previewSessionId !== subscription.previewSessionId) return false
  const seenGeneration = Math.max(
    scope.seenGenerations.get(subscription.previewSessionId) ?? 0,
    subscription.lastGeneration
  )
  if (runtimeEvent.runtimeGeneration < seenGeneration) return false
  if (runtimeEvent.runtimeGeneration === seenGeneration) {
    return runtimeEvent.sequence > subscription.lastSequence
  }
  return runtimeEvent.sequence > 0
}

const candidateChannels = {
  ready: 'scene-preview:ready',
  stageFailed: 'scene-preview:stage-failed',
  invalidated: 'scene-preview:invalidated'
} as const

function bindCandidatePreviewEvents(
  scenePreview: ScenePreviewController,
  getWindow: () => BrowserWindow | null
): () => void {
  return scenePreview.subscribeCandidateEvents((event) => {
    const window = getWindow()
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return
    window.webContents.send(candidateChannels[event.type], safeCandidateEvent(event))
  })
}

function safeCandidateEvent(
  event: SceneGenerationCandidatePreviewEventVO
): SceneGenerationCandidatePreviewEventVO {
  const identity = {
    sequence: event.sequence,
    projectId: event.projectId,
    sceneId: event.sceneId,
    previewSessionId: event.previewSessionId,
    candidateSnapshotId: event.candidateSnapshotId
  }
  if (event.type === 'invalidated') return { type: 'invalidated', ...identity }
  return event.message
    ? { type: event.type, ...identity, message: event.message }
    : { type: event.type, ...identity }
}
