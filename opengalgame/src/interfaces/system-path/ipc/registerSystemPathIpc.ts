import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'

import { createIpcRequestAccess } from '../../ipc/createIpcRequestAccess'
import type { SystemPathController } from './SystemPathController'

interface SystemPathIpcBinding {
  systemPath: SystemPathController
  getWindow: () => BrowserWindow | null
  rendererUrl: string
}

export function registerSystemPathIpc(options: SystemPathIpcBinding): () => void {
  const access = createIpcRequestAccess(options)
  const handlers: Record<string, (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>> =
    {
      'system:open-directory': (event, input) =>
        options.systemPath.openDirectory(input, access(event))
    }
  for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, handler)
  return () => {
    for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel)
  }
}
