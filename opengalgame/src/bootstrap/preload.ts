import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

import type {
  DesktopBridgeEventChannel,
  DesktopBridgeInvokeChannel
} from '@interfaces/contracts/desktopBridgeChannels'
import { createDesktopBridge } from '@interfaces/preload/DesktopBridge'

contextBridge.exposeInMainWorld(
  'opengalgame',
  createDesktopBridge({
    invoke: (channel: DesktopBridgeInvokeChannel, input?: unknown) =>
      ipcRenderer.invoke(channel, input),
    subscribe: (channel: DesktopBridgeEventChannel, listener) => {
      const receive = (_event: IpcRendererEvent, value: unknown): void => listener(value)
      ipcRenderer.on(channel, receive)
      return () => {
        ipcRenderer.removeListener(channel, receive)
      }
    }
  })
)
