import { dialog, type BrowserWindow, type OpenDialogOptions } from 'electron'

import type { ProjectFileChooser } from '@interfaces/project-files/ipc/ProjectFileChooser'

/** 用系统文件选择器取得待导入路径。 */
export class ElectronProjectFileChooser implements ProjectFileChooser {
  /**
   * @param getWindow - 当前受信任窗口。没有窗口时仍可选择。
   */
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
