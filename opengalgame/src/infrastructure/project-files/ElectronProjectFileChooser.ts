import { dialog, type BrowserWindow, type OpenDialogOptions } from 'electron'

import type { ProjectFileChooser } from '@application/project-files/ports/ProjectFileChooser'
import type { ProjectFileAssetKind } from '@application/project-files/vo/ProjectInputSourceVO'
import { mediaExtensionsForCategories } from '@common/media/mediaFileName'

const filterNames: Record<ProjectFileAssetKind, string> = {
  image: '图片',
  audio: '音频',
  video: '视频'
}

export class ElectronProjectFileChooser implements ProjectFileChooser {
  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly showDialog: typeof dialog.showOpenDialog = dialog.showOpenDialog
  ) {}

  async chooseProjectFiles(
    mediaKinds?: readonly ProjectFileAssetKind[]
  ): Promise<readonly string[] | null> {
    const extensions =
      mediaKinds && mediaKinds.length > 0 ? mediaExtensionsForCategories(mediaKinds) : []
    const options: OpenDialogOptions = {
      properties: ['openFile', 'multiSelections'],
      ...(extensions.length > 0
        ? { filters: [{ name: filterNameOf(mediaKinds ?? []), extensions: [...extensions] }] }
        : {})
    }
    const parent = this.getWindow()
    const result = parent ? await this.showDialog(parent, options) : await this.showDialog(options)
    if (result.canceled) return null
    return result.filePaths
  }
}

function filterNameOf(mediaKinds: readonly ProjectFileAssetKind[]): string {
  if (mediaKinds.length !== 1) return '支持的素材'
  return filterNames[mediaKinds[0]!]
}
