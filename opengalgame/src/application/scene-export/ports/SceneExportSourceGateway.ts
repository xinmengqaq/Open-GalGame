import type { SceneIdentity } from '@domain/scenes/models/SceneIdentity'

import type { SceneExportContentBasis } from '../vo/SceneExportContentBasis'
import type { SceneExportVersionReference } from '../vo/SceneExportVO'

export type SavedSceneReferencedAsset = {
  readonly sourcePath: string
  readonly packagePath: string
}

export type SavedSceneExportSource = {
  readonly scene: SceneIdentity
  readonly contentBasis: SceneExportContentBasis
  readonly versionReference: SceneExportVersionReference
  readonly entryRelativePath: string
  /** 读取时入口脚本字节的 sha256；打包长时间运行后可据此确认正式场景未变化。 */
  readonly entrySha256: string
  readonly sceneText: string
  readonly referencedAssets: readonly SavedSceneReferencedAsset[]
}

export interface SceneExportSourceGateway {
  readSavedScene(scene: SceneIdentity): Promise<SavedSceneExportSource>
}
