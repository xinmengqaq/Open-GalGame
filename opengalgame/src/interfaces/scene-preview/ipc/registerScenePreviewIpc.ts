import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'

import type { SceneGenerationCandidatePreviewEventVO } from '@application/scene-generation/vo/SceneGenerationRenderVO'
import type { SceneCandidatePreviewGateway } from '@application/scene-generation/ports/SceneCandidatePreviewGateway'
import type { PreviewRuntimeEventVO } from '@application/scene-preview/vo/PreviewRuntimeVO'
import { createIpcRequestAccess, isTrustedIpcSender } from '../../ipc/createIpcRequestAccess'
import { ErrorCodes } from '@common/errors/ErrorCodes'
import { parseRequest } from '../../ipc/RequestSchema'
import { subscribePreviewRuntimeSchema } from './ScenePreviewRequestSchema'
import type { ScenePreviewController } from './ScenePreviewController'

interface ScenePreviewIpcBinding {
  scenePreview: ScenePreviewController
  candidatePreview?: SceneCandidatePreviewGateway
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

const subscriptions = new Map<number, ScenePreviewSubscription>()
const seenGenerations = new Map<string, number>()
let stopCandidateEvents: (() => void) | undefined

/**
 * 注册固定预览通道。运行时订阅随窗口、关闭和注销一起释放。
 * listener 只留在主进程，不进入 IPC 载荷。
 */
export function registerScenePreviewIpc(options: ScenePreviewIpcBinding): () => void {
  const access = createIpcRequestAccess(options)
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
      'scene-preview:close': (event, input) => closeScenePreview(options, event, input),
      'scene-preview:subscribe': (event, input) =>
        subscribeScenePreviewRuntime(options, event, input),
      'scene-preview:read-candidate': (event, input) =>
        options.scenePreview.readCandidate(input, access(event)),
      'scene-preview:candidate-event': (event, input) =>
        options.scenePreview.readCandidateEvent(input, access(event), (previewSessionId) =>
          options.candidatePreview?.readCandidatePreviewEvent(previewSessionId)
        )
    }
  for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, handler)
  stopCandidateEvents?.()
  stopCandidateEvents = options.candidatePreview
    ? bindCandidatePreviewEvents(options.candidatePreview, options.getWindow)
    : undefined
  return () => {
    for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel)
    releaseScenePreviewSubscriptions()
  }
}

export function releaseScenePreviewSubscriptions(): void {
  for (const subscription of subscriptions.values()) subscription.unsubscribe()
  subscriptions.clear()
  seenGenerations.clear()
  stopCandidateEvents?.()
  stopCandidateEvents = undefined
}

async function closeScenePreview(
  options: ScenePreviewIpcBinding,
  event: IpcMainInvokeEvent,
  input: unknown
): Promise<unknown> {
  const requestAccess = createIpcRequestAccess(options)(event)
  const closed = await options.scenePreview.close(input, requestAccess)
  if (closed.code === 2000) releaseSenderSubscription(event.sender?.id)
  return closed
}

async function subscribeScenePreviewRuntime(
  options: ScenePreviewIpcBinding,
  event: IpcMainInvokeEvent,
  input: unknown
): Promise<unknown> {
  const requestAccess = createIpcRequestAccess(options)(event)
  const sender = event.sender
  const queued: PreviewRuntimeEventVO[] = []
  let current: ScenePreviewSubscription | undefined
  const publish = (runtimeEvent: PreviewRuntimeEventVO): void => {
    if (!current) {
      queued.push(runtimeEvent)
      return
    }
    deliverRuntimeEvent(options, event, sender, current, runtimeEvent)
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
  releaseSenderSubscription(sender.id)
  current = {
    senderId: sender.id,
    previewSessionId: request.previewSessionId,
    lastGeneration: 0,
    lastSequence: 0,
    unsubscribe: subscribed.unsubscribe
  }
  subscriptions.set(sender.id, current)
  for (const runtimeEvent of queued) {
    deliverRuntimeEvent(options, event, sender, current, runtimeEvent)
  }
  sender.once('destroyed', () => {
    releaseSenderSubscription(sender.id)
  })
  return subscribed.accepted
}

function deliverRuntimeEvent(
  options: ScenePreviewIpcBinding,
  event: IpcMainInvokeEvent,
  sender: IpcMainInvokeEvent['sender'] | undefined,
  current: ScenePreviewSubscription,
  runtimeEvent: PreviewRuntimeEventVO
): void {
  if (
    !sender ||
    sender.isDestroyed() ||
    !isTrustedIpcSender(event, options) ||
    !isCurrentRuntimeEvent(current, runtimeEvent)
  ) {
    return
  }
  const seenGeneration = seenGenerations.get(current.previewSessionId) ?? 0
  current.lastGeneration = Math.max(seenGeneration, runtimeEvent.runtimeGeneration)
  current.lastSequence = runtimeEvent.sequence
  seenGenerations.set(current.previewSessionId, current.lastGeneration)
  sender.send('scene-preview:runtime', runtimeEvent)
}

function releaseSenderSubscription(senderId: number | undefined): void {
  if (senderId === undefined) return
  subscriptions.get(senderId)?.unsubscribe()
  subscriptions.delete(senderId)
}

function isCurrentRuntimeEvent(
  subscription: ScenePreviewSubscription,
  runtimeEvent: PreviewRuntimeEventVO
): boolean {
  if (runtimeEvent.previewSessionId !== subscription.previewSessionId) return false
  const seenGeneration = Math.max(
    seenGenerations.get(subscription.previewSessionId) ?? 0,
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

/**
 * 注册时就订阅，打开返回前到达的事件不会丢。
 * 只发给当前窗口；窗口销毁或注销时退订。载荷不含路径和诊断。
 */
function bindCandidatePreviewEvents(
  preview: SceneCandidatePreviewGateway,
  getWindow: () => BrowserWindow | null
): () => void {
  const unsubscribe = preview.subscribeCandidatePreviewEvents((event) => {
    const window = getWindow()
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return
    window.webContents.send(candidateChannels[event.type], safeCandidateEvent(event))
  })
  return unsubscribe
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
