import { dialog, type BrowserWindow, type OpenDialogOptions } from 'electron'

import type { ProjectFileChooser } from '@application/project-files/ports/ProjectFileChooser'

export class ElectronProjectFileChooser implements ProjectFileChooser {
  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly showDialog: typeof dialog.showOpenDialog = dialog.showOpenDialog
  ) {}

  async chooseProjectFiles(): Promise<readonly string[] | null> {
    const parent = this.getWindow()
    const options: OpenDialogOptions = { properties: ['openFile', 'multiSelections'] }
    const result = parent ? await this.showDialog(parent, options) : await this.showDialog(options)
    if (result.canceled) return null
    return result.filePaths
  }
}
