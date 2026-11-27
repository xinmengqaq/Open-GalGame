import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'

import { createIpcRequestAccess } from '@interfaces/ipc/createIpcRequestAccess'
import type { AppearanceSettingsController } from '@interfaces/settings/appearance/ipc/AppearanceSettingsController'
import type { ConnectionSettingsController } from '@interfaces/settings/connections/ipc/ConnectionSettingsController'

interface SettingsIpcBinding {
  connections: ConnectionSettingsController
  appearance: AppearanceSettingsController
  getWindow: () => BrowserWindow | null
  rendererUrl: string
}

export function registerSettingsIpc(options: SettingsIpcBinding): () => void {
  const access = createIpcRequestAccess(options)
  const handlers: Record<string, (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>> =
    {
      'connection:get-summary': (event, input) =>
        options.connections.getSettingsSummary(input, access(event)),
      'connection:test': (event, input) => options.connections.testConnection(input, access(event)),
      'connection:save': (event, input) =>
        options.connections.saveSettings(input, access(event)),
      'connection:list-models': (event, input) =>
        options.connections.listModels(input, access(event)),
      'settings:read-appearance': (event, input) =>
        options.appearance.readAppearance(input, access(event)),
      'settings:save-appearance': (event, input) =>
        options.appearance.saveAppearance(input, access(event))
    }
  for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, handler)

  return () => {
    for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel)
  }
}
