import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'

import { createIpcRequestAccess, isTrustedIpcSender } from './createIpcRequestAccess'
import type { ProjectController } from './controllers/ProjectController'
import type { ProjectProgressVO } from '@application/projects/vo/ProjectVO'

export function registerHomeIpc(options: {
  projects: ProjectController
  getWindow: () => BrowserWindow | null
  rendererUrl: string
}): () => void {
  const access = createIpcRequestAccess(options)
  const progress =
    (event: IpcMainInvokeEvent) =>
    (value: ProjectProgressVO): void => {
      if (!event.sender.isDestroyed() && isTrustedIpcSender(event, options))
        event.sender.send('project:progress', value)
    }

  const handlers: Record<string, (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>> =
    {
      'project:choose-save-location': (event, input) =>
        options.projects.chooseSaveLocation(input, access(event)),
      'project:clear-save-location': (event, input) =>
        options.projects.clearSaveLocation(input, access(event)),
      'project:create': (event, input) =>
        options.projects.createProject(input, access(event), progress(event)),
      'project:import': (event, input) =>
        options.projects.importProject(input, access(event), progress(event)),
      'project:list': (event, input) => options.projects.listProjects(input, access(event)),
      'project:open': (event, input) => options.projects.openProject(input, access(event)),
      'project:rename': (event, input) => options.projects.renameProject(input, access(event)),
      'project:unregister': (event, input) =>
        options.projects.unregisterProject(input, access(event)),
      'project:ensure-workspace': (event, input) =>
        options.projects.ensureProjectWorkspace(input, access(event)),
      'project:inspect-workspace': (event, input) =>
        options.projects.inspectProjectWorkspace(input, access(event))
    }

  for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, handler)
  return () => {
    for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel)
  }
}
