import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'

import { isSameDocumentUrl } from './isSameDocumentUrl'
import type { IpcRequestAccess } from './RequestSchema'

interface IpcWindowBinding {
  getWindow: () => BrowserWindow | null
  rendererUrl: string
}

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
