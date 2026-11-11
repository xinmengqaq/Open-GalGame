import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'

import type { SceneGenerationRenderProgressEventVO } from '@application/scene-generation/vo/SceneGenerationRenderVO'
import { createIpcRequestAccess, isTrustedIpcSender } from '../../ipc/createIpcRequestAccess'
import { parseRequest } from '../../ipc/RequestSchema'
import { sceneGenerationProgressSchema } from './SceneGenerationRequestSchema'
import type { SceneGenerationController } from './SceneGenerationController'

interface SceneGenerationIpcBinding {
  sceneGeneration: SceneGenerationController
  getWindow: () => BrowserWindow | null
  rendererUrl: string
}

interface SceneGenerationSubscription {
  senderId: number
  unsubscribe: () => void
}

const subscriptions = new Map<number, SceneGenerationSubscription>()

/**
 * 注册固定生成通道。进度订阅随窗口和注销一起释放。
 * @param options - 控制器和受信任窗口。
 */
export function registerSceneGenerationIpc(options: SceneGenerationIpcBinding): () => void {
  const access = createIpcRequestAccess(options)
  const handlers: Record<string, (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>> =
    {
      'scene-generation:start': (event, input) =>
        options.sceneGeneration.start(input, access(event)),
      'scene-generation:retry-repair': (event, input) =>
        options.sceneGeneration.retryRepair(input, access(event)),
      'scene-generation:status': (event, input) =>
        options.sceneGeneration.status(input, access(event)),
      'scene-generation:latest': (event, input) =>
        options.sceneGeneration.latest(input, access(event)),
      'scene-generation:reply': (event, input) =>
        options.sceneGeneration.reply(input, access(event)),
      'scene-generation:pause': (event, input) =>
        options.sceneGeneration.pause(input, access(event)),
      'scene-generation:resume': (event, input) =>
        options.sceneGeneration.resume(input, access(event)),
      'scene-generation:cancel': (event, input) =>
        options.sceneGeneration.cancel(input, access(event)),
      'scene-generation:list-history': (event, input) =>
        options.sceneGeneration.listHistory(input, access(event)),
      'scene-generation:read-checkpoint': (event, input) =>
        options.sceneGeneration.readCheckpoint(input, access(event)),
      'scene-generation:open-preview': (event, input) =>
        options.sceneGeneration.openPreview(input, access(event)),
      'scene-generation:close-preview': (event, input) =>
        options.sceneGeneration.closePreview(input, access(event)),
      'scene-generation:progress': (event, input) =>
        subscribeSceneGenerationProgress(options, event, input)
    }
  for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, handler)
  return () => {
    for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel)
    releaseSceneGenerationSubscriptions()
  }
}

/** 后端关闭时释放全部生成进度订阅。预览运行时由生成装配关闭。 */
export function releaseSceneGenerationSubscriptions(): void {
  for (const subscription of subscriptions.values()) subscription.unsubscribe()
  subscriptions.clear()
}

async function subscribeSceneGenerationProgress(
  options: SceneGenerationIpcBinding,
  event: IpcMainInvokeEvent,
  input: unknown
): Promise<unknown> {
  const requestAccess = createIpcRequestAccess(options)(event)
  const accepted = await options.sceneGeneration.subscribe(input, requestAccess)
  if (accepted.code !== 2000 || !event.sender || event.sender.isDestroyed()) return accepted
  const request = parseRequest(sceneGenerationProgressSchema, input, requestAccess)
  const publish = (progress: SceneGenerationRenderProgressEventVO): void => {
    if (
      event.sender.isDestroyed() ||
      !isTrustedIpcSender(event, options) ||
      progress.operationId !== request.operationId ||
      progress.threadId !== request.threadId ||
      progress.branchId !== request.branchId
    ) {
      return
    }
    event.sender.send('scene-generation:progress', progress)
  }
  subscriptions.get(event.sender.id)?.unsubscribe()
  const unsubscribe = options.sceneGeneration.watchProgress(request, publish)
  subscriptions.set(event.sender.id, { senderId: event.sender.id, unsubscribe })
  event.sender.once('destroyed', () => {
    unsubscribe()
    if (!event.sender.isDestroyed()) subscriptions.delete(event.sender.id)
  })
  return accepted
}
