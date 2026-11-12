import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'

import type { UpdateStatusVO } from '@application/app-update/vo/AppUpdateVO'
import { createIpcRequestAccess } from '../../ipc/createIpcRequestAccess'
import { parseUpdateStatusEvent } from '../contracts/AppUpdateResponseSchema'
import type { AppUpdateController } from './AppUpdateController'

interface AppUpdateIpcBinding {
  controller: AppUpdateController
  subscribe: (listener: (status: UpdateStatusVO) => void) => () => void
  getWindow: () => BrowserWindow | null
  rendererUrl: string
}

/**
 * 注册固定更新通道。请求只进入应用更新用例，不接受发布源或安装参数。
 * 状态推送只发往仍存活的主窗口，注销时移除通道并退订。
 */
export function registerAppUpdateIpc(options: AppUpdateIpcBinding): () => void {
  const access = createIpcRequestAccess(options)
  const handlers: Record<string, (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>> =
    {
      'app-update:check': (event, input) => options.controller.checkForUpdate(input, access(event)),
      'app-update:download': (event, input) =>
        options.controller.downloadUpdate(input, access(event)),
      'app-update:install': (event, input) =>
        options.controller.installUpdate(input, access(event)),
      'app-update:read-status': (event, input) =>
        options.controller.readUpdateStatus(input, access(event))
    }
  for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, handler)

  const publish = (value: unknown): void => {
    const status = parseUpdateStatusEvent(value)
    if (status === null) return
    const window = options.getWindow()
    if (window === null || window.isDestroyed() || window.webContents.isDestroyed()) return
    window.webContents.send('app-update:status', status)
  }
  const unsubscribe = options.subscribe(publish)

  return () => {
    for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel)
    unsubscribe()
  }
}
