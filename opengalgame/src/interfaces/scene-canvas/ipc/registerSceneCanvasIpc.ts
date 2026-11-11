import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'

import { createIpcRequestAccess } from '../../ipc/createIpcRequestAccess'
import type { SceneCanvasController } from './SceneCanvasController'

/**
 * 注册固定场景画布通道。注册与注销共用同一份通道表。
 * @param options - 控制器和受信任窗口。
 */
export function registerSceneCanvasIpc(options: {
  sceneCanvas: SceneCanvasController
  getWindow: () => BrowserWindow | null
  rendererUrl: string
}): () => void {
  const access = createIpcRequestAccess(options)
  const handlers: Record<string, (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>> =
    {
      'scene-canvas:read-arrangement': (event, input) =>
        options.sceneCanvas.readSceneCanvasArrangement(input, access(event)),
      'scene-canvas:create-source-card': (event, input) =>
        options.sceneCanvas.createSourceCard(input, access(event)),
      'scene-canvas:create-prompt-card': (event, input) =>
        options.sceneCanvas.createPromptCard(input, access(event)),
      'scene-canvas:create-field-card': (event, input) =>
        options.sceneCanvas.createFieldCard(input, access(event)),
      'scene-canvas:edit-card': (event, input) =>
        options.sceneCanvas.editCard(input, access(event)),
      'scene-canvas:edit-prompt-body': (event, input) =>
        options.sceneCanvas.editPromptBody(input, access(event)),
      'scene-canvas:bind-field-card-preset': (event, input) =>
        options.sceneCanvas.bindFieldCardPreset(input, access(event)),
      'scene-canvas:edit-media-role': (event, input) =>
        options.sceneCanvas.editMediaRole(input, access(event)),
      'scene-canvas:copy-card': (event, input) =>
        options.sceneCanvas.copyCard(input, access(event)),
      'scene-canvas:delete-card': (event, input) =>
        options.sceneCanvas.deleteCard(input, access(event)),
      'scene-canvas:connect-cards': (event, input) =>
        options.sceneCanvas.connectCards(input, access(event)),
      'scene-canvas:disconnect-cards': (event, input) =>
        options.sceneCanvas.disconnectCards(input, access(event)),
      'scene-canvas:edit-relation-name': (event, input) =>
        options.sceneCanvas.editRelationName(input, access(event)),
      'scene-canvas:attach-relation-record': (event, input) =>
        options.sceneCanvas.attachRelationRecord(input, access(event)),
      'scene-canvas:detach-relation-record': (event, input) =>
        options.sceneCanvas.detachRelationRecord(input, access(event)),
      'scene-canvas:save-arrangement': (event, input) =>
        options.sceneCanvas.saveSceneCanvasArrangement(input, access(event))
    }
  for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, handler)
  return () => {
    for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel)
  }
}
