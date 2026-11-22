import type { SceneExportContentBasis } from './SceneExportContentBasis'
import type { SceneExportVersionReference } from './SceneExportVO'

/**
 * 当前工程场景最新可导出的正式版本。
 * 只带可核对身份与内容依据，不暴露路径或编辑内容。
 */
export type SavedSceneVersionVO = {
  readonly versionReference: SceneExportVersionReference
  readonly revisionDigest: string
  readonly contentBasis: SceneExportContentBasis
}
