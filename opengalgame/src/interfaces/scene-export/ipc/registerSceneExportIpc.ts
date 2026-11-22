import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'

import { createIpcRequestAccess } from '../../ipc/createIpcRequestAccess'
import type { SceneExportController } from './SceneExportController'

interface SceneExportIpcBinding {
  sceneExport: SceneExportController
  getWindow: () => BrowserWindow | null
  rendererUrl: string
}

export function registerSceneExportIpc(options: SceneExportIpcBinding): () => void {
  const access = createIpcRequestAccess(options)
  const handlers: Record<string, (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>> =
    {
      'scene-export:export-saved-scene': (event, input) =>
        options.sceneExport.exportSavedScene(input, access(event)),
      'scene-export:read-latest-saved-scene-version': (event, input) =>
        options.sceneExport.readLatestSavedSceneVersion(input, access(event)),
      'scene-export:choose-directory': (event, input) =>
        options.sceneExport.chooseSceneExportDirectory(input, access(event))
    }
  for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, handler)
  return () => {
    for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel)
  }
}
