import type { SceneIdentity } from '@domain/scenes/models/SceneIdentity'
import type { SceneContentBasisVO } from '@application/scene-preview/vo/ScenePreviewSessionVO'

import type { SceneExportVersionReference } from '../vo/SceneExportVO'

export type SavedSceneReferencedAsset = {
  readonly sourcePath: string
  readonly packagePath: string
}

/**
 * 已核对的正式场景内容。
 * 绝对路径只留在基础设施，不进入应用结果。
 */
export type SavedSceneExportSource = {
  readonly scene: SceneIdentity
  readonly contentBasis: SceneContentBasisVO
  readonly versionReference: SceneExportVersionReference
  readonly entryRelativePath: string
  readonly sceneText: string
  readonly referencedAssets: readonly SavedSceneReferencedAsset[]
}

export interface SceneExportSourceGateway {
  /**
   * 读取本次保存成功并仍与正式工程一致的单场景内容。
   * 没有保存成功、内容变化或路径越界时失败，不返回可导出内容。
   */
  readSavedScene(scene: SceneIdentity): Promise<SavedSceneExportSource>
}
