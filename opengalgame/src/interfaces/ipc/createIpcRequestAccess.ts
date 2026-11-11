import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'

import { isSameDocumentUrl } from './isSameDocumentUrl'
import type { IpcRequestAccess } from './RequestSchema'

interface IpcWindowBinding {
  getWindow: () => BrowserWindow | null
  rendererUrl: string
}

/**
 * 判断调用是否来自当前受信任窗口的主框架，且仍位于预期文档。
 * 每次读取当前窗口，不沿用上一次判断。
 */
export function isTrustedIpcSender(event: IpcMainInvokeEvent, binding: IpcWindowBinding): boolean {
  const window = binding.getWindow()
  if (
    !window ||
    window.isDestroyed() ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame
  ) {
    return false
  }
  return isSameDocumentUrl(event.senderFrame.url, binding.rendererUrl)
}

export function createIpcRequestAccess(
  binding: IpcWindowBinding
): (event: IpcMainInvokeEvent) => IpcRequestAccess {
  return (event) => ({
    trusted: isTrustedIpcSender(event, binding),
    requestId: randomUUID()
  })
}
