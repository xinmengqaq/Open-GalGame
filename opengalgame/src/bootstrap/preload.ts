import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

import type { ProjectProgressVO } from '@application/projects/vo/ProjectVO'
import { createDesktopBridge } from '@interfaces/preload/DesktopBridge'

contextBridge.exposeInMainWorld(
  'opengalgame',
  createDesktopBridge({
    /** 把渲染进程请求转发到主进程固定通道。 */
    invoke: (channel, input) => ipcRenderer.invoke(channel, input),
    /** 订阅主进程推送，并返回注销函数。 */
    subscribe: (channel, listener) => {
      /** 剥离 Electron 事件，只把进度值转交订阅者。 */
      const receive = (_event: IpcRendererEvent, value: ProjectProgressVO): void => listener(value)
      ipcRenderer.on(channel, receive)
      return () => {
        ipcRenderer.removeListener(channel, receive)
      }
    }
  })
)
