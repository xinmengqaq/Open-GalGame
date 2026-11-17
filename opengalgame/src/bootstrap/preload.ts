import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

import type {
  DesktopBridgeEventChannel,
  DesktopBridgeInvokeChannel
} from '@interfaces/contracts/desktopBridgeChannels'
import { createDesktopBridge } from '@interfaces/preload/DesktopBridge'

contextBridge.exposeInMainWorld(
  'opengalgame',
  createDesktopBridge({
    /** 把渲染进程请求转发到主进程固定通道。 */
    invoke: (channel: DesktopBridgeInvokeChannel, input?: unknown) =>
      ipcRenderer.invoke(channel, input),
    /** 订阅主进程推送，并返回注销函数。 */
    subscribe: (channel: DesktopBridgeEventChannel, listener) => {
      /** 剥离 Electron 事件，只把载荷转交订阅者。 */
      const receive = (_event: IpcRendererEvent, value: unknown): void => listener(value)
      ipcRenderer.on(channel, receive)
      return () => {
        ipcRenderer.removeListener(channel, receive)
      }
    }
  })
)
