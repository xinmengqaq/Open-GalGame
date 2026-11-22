import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'

import { createIpcRequestAccess } from '../../ipc/createIpcRequestAccess'
import type { ProjectFilesController } from './ProjectFilesController'

export function registerProjectFilesIpc(options: {
  projectFiles: ProjectFilesController
  getWindow: () => BrowserWindow | null
  rendererUrl: string
}): () => void {
  const access = createIpcRequestAccess(options)
  const handlers: Record<string, (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>> =
    {
      'project-files:inspect': (event, input) =>
        options.projectFiles.inspectProjectFiles(input, access(event)),
      'project-files:list-input-sources': (event, input) =>
        options.projectFiles.listProjectInputSources(input, access(event)),
      'project-files:read-input-sources': (event, input) =>
        options.projectFiles.readProjectInputSources(input, access(event)),
      'project-files:read-media': (event, input) =>
        options.projectFiles.readProjectMedia(input, access(event)),
      'project-files:choose-files': (event, input) =>
        options.projectFiles.chooseProjectFiles(input, access(event)),
      'project-files:import': (event, input) =>
        options.projectFiles.importProjectFiles(input, access(event)),
      'project-files:open': (event, input) =>
        options.projectFiles.openProjectFile(input, access(event)),
      'project-files:rename': (event, input) =>
        options.projectFiles.renameProjectFile(input, access(event)),
      'project-files:delete': (event, input) =>
        options.projectFiles.deleteProjectFile(input, access(event)),
      'project-files:create-text': (event, input) =>
        options.projectFiles.createProjectTextFile(input, access(event)),
      'project-files:update-text-body': (event, input) =>
        options.projectFiles.updateProjectTextFileBody(input, access(event)),
      'project-files:create-folder': (event, input) =>
        options.projectFiles.createProjectFolder(input, access(event)),
      'project-files:copy-file': (event, input) =>
        options.projectFiles.copyProjectFile(input, access(event)),
      'project-files:move-file': (event, input) =>
        options.projectFiles.moveProjectFile(input, access(event)),
      'project-files:copy-folder': (event, input) =>
        options.projectFiles.copyProjectFolder(input, access(event)),
      'project-files:rename-folder': (event, input) =>
        options.projectFiles.renameProjectFolder(input, access(event)),
      'project-files:folder-deletion-plan': (event, input) =>
        options.projectFiles.readProjectFolderDeletionPlan(input, access(event)),
      'project-files:delete-folder': (event, input) =>
        options.projectFiles.deleteProjectFolder(input, access(event)),
      'project-files:read-operation': (event, input) =>
        options.projectFiles.readProjectFileOperation(input, access(event)),
      'project-files:recover-operations': (event, input) =>
        options.projectFiles.recoverProjectFileOperations(input, access(event))
    }

  for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, handler)
  return () => {
    for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel)
  }
}
