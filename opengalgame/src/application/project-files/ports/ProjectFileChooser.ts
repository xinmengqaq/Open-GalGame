import type { ProjectFileAssetKind } from '../vo/ProjectInputSourceVO'

export interface ProjectFileChooser {
  chooseProjectFiles(
    mediaKinds?: readonly ProjectFileAssetKind[]
  ): Promise<readonly string[] | null>
}
