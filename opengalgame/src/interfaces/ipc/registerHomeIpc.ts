import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'

import type { ConnectionSettingsController } from './controllers/ConnectionSettingsController'
import { createIpcRequestAccess, isTrustedIpcSender } from './createIpcRequestAccess'
import type { ProjectController } from './controllers/ProjectController'
import type { ProjectProgressVO } from '@application/projects/vo/ProjectVO'

/**
 * 注册固定首页通道。注册与注销共用同一份通道表。
 * @param options - 控制器和受信任窗口。
 */
export function registerHomeIpc(options: {
  projects: ProjectController
  connections: ConnectionSettingsController
  getWindow: () => BrowserWindow | null
  rendererUrl: string
}): () => void {
  const access = createIpcRequestAccess(options)
  /** 生成当前操作的进度转发，只向仍受信任的来源发送进度。 */
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
      /** 清除新建待用的保存位置。 */
      'project:clear-save-location': (event, input) =>
        options.projects.clearSaveLocation(input, access(event)),
      /** 创建项目并转发本操作进度。 */
      'project:create': (event, input) =>
        options.projects.createProject(input, access(event), progress(event)),
      /** 导入目录并转发本操作进度。 */
      'project:import': (event, input) =>
        options.projects.importProject(input, access(event), progress(event)),
      /** 读取一页本机已登记项目。 */
      'project:list': (event, input) => options.projects.listProjects(input, access(event)),
      'project:open': (event, input) => options.projects.openProject(input, access(event)),
      'project:rename': (event, input) => options.projects.renameProject(input, access(event)),
      'project:unregister': (event, input) =>
        options.projects.unregisterProject(input, access(event)),
      /** 核对已登记工程的默认场景和作品基线。 */
      'project:ensure-workspace': (event, input) =>
        options.projects.ensureProjectWorkspace(input, access(event)),
      /** 只读检查已登记工程的工作区，不补建。 */
      'project:inspect-workspace': (event, input) =>
        options.projects.inspectProjectWorkspace(input, access(event)),
      'connection:get-summary': (event, input) =>
        options.connections.getSettingsSummary(input, access(event)),
      'connection:test': (event, input) => options.connections.testConnection(input, access(event)),
      'connection:save': (event, input) => options.connections.saveSettings(input, access(event)),
      'connection:list-models': (event, input) =>
        options.connections.listModels(input, access(event))
    }

  for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, handler)
  return () => {
    for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel)
  }
}
