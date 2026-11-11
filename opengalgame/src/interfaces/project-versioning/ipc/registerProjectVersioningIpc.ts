import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'

import { createIpcRequestAccess } from '../../ipc/createIpcRequestAccess'
import type { ProjectVersioningController } from './ProjectVersioningController'

/**
 * 注册三条用户历史通道。注册与注销共用同一份通道表。
 * @param options - 控制器和受信任窗口。
 */
export function registerProjectVersioningIpc(options: {
  projectVersioning: ProjectVersioningController
  getWindow: () => BrowserWindow | null
  rendererUrl: string
}): () => void {
  const access = createIpcRequestAccess(options)
  const handlers: Record<string, (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>> =
    {
      'project-versioning:list-history': (event, input) =>
        options.projectVersioning.listHistory(input, access(event)),
      'project-versioning:undo-history-entry': (event, input) =>
        options.projectVersioning.undoHistoryEntry(input, access(event)),
      'project-versioning:clear-history': (event, input) =>
        options.projectVersioning.clearHistory(input, access(event))
    }
  for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, handler)
  return () => {
    for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel)
  }
}
